import type { IntelligenceMessage, IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";
import { setting, envValue } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError, codeForStatus } from "../lib/errors";
import { HttpError, bodySnippet, safeFetch, type FetchLike } from "../lib/http";
import { Semaphore, SemaphoreTimeoutError } from "../lib/limiter";
import { jsonSchemaFor, mergeSystemMessages, parseAndValidate, repairMessages } from "../lib/structured";
import { normalizeStructured, schemaGuide, schemaNameFor, structuredSystemPrompt } from "./prompts";

/**
 * GX cluster adapter — local GX10 compute behind the LiteLLM gateway
 * (OpenAI-compatible `POST {GX_BASE_URL}/chat/completions`). Free: cost is
 * always $0 with costSource "free".
 *
 * Credentials (package-wide approach, see lib/credentials.ts): the gateway
 * key GX_API_KEY resolves per call from the bound tenant (`withTenant`) or
 * `req.context.tenantId` (tenant secret) → env. GX_BASE_URL is server config
 * only (never tenant-supplied). `isConfigured()` = env GX_BASE_URL + GX_API_KEY.
 *
 * Models: gx-mini for cheap/short tasks, gx-code for reasoning/drafting.
 * gx-max is NEVER used (hard guard below).
 *
 * Structured output: JSON Schema (zod 4 `z.toJSONSchema`) in the system
 * prompt AND `response_format: json_schema` (the gateway's llama.cpp backend
 * grammar-constrains decoding). Falls back to `json_object`, then to prompt
 * only, when the backend rejects a format (remembered per model). Output is
 * validated with the zod schema; ONE repair round-trip on failure.
 *
 * Concurrency: process-wide semaphores (GX_MAX_CONCURRENCY, default 2 —
 * gx-mini has 2 slots; GX_CODE_MAX_CONCURRENCY for gx-code). Waiting for a
 * slot is bounded by GX_ACQUIRE_TIMEOUT_MS (→ ProviderError "timeout", so the
 * router falls through / trips its breaker instead of piling up). Waiters are
 * served by task priority (see `gxTaskPriority`). Request timeout GX_TIMEOUT_MS.
 */

const FAST_TASKS = new Set<IntelligenceTask>(["triage", "extract", "classify", "summarise", "dedupe", "tag", "qa_basic", "log_analysis"]);

/**
 * Slot priority (higher first). Owner-facing production, QA, recovery,
 * proposals and client messages overtake background work so a won job never
 * waits behind a backlog of opportunity refinements:
 *   2 — everything else (code, plan_production, qa_*, recovery, proposal, client_message, …)
 *   1 — market_research
 *   0 — analyse_opportunity (background refinement)
 */
export function gxTaskPriority(task: IntelligenceTask): number {
  if (task === "analyse_opportunity") return 0;
  if (task === "market_research") return 1;
  return 2;
}

/** True when the task runs on the shared heavy model (gx-code), i.e. counts against the tenant GX quota. */
export function isHeavyGxTask(task: IntelligenceTask): boolean {
  return !FAST_TASKS.has(task);
}

/** Default output budgets per task (the gateway clamps to the model maximum). */
function defaultMaxTokens(task: IntelligenceTask, structured: boolean): number {
  if (task === "analyse_opportunity" || task === "plan_production") return 6000;
  if (task === "proposal" || task === "code" || task === "market_research") return 4000;
  if (FAST_TASKS.has(task)) return structured ? 2000 : 1200;
  return 3000;
}

type FormatLevel = "json_schema" | "json_object" | "none";
const formatSupport = new Map<string, FormatLevel>();

const slots = new Semaphore(() => setting("GX_MAX_CONCURRENCY"));
/**
 * gx-code runs one llama.cpp slot per node (2 cluster-wide) and is shared with
 * AgentOS and other GX clients — GigPilot takes at most GX_CODE_MAX_CONCURRENCY
 * (default 1) of them so other workloads are never starved.
 */
const heavySlots = new Semaphore(() => setting("GX_CODE_MAX_CONCURRENCY"));

export interface GxOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
  /** Override the model for every task (tests / diagnostics). */
  model?: string;
}

interface ChatCompletion {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

function assertNotMax(model: string): string {
  if (/gx-max/i.test(model)) throw new ProviderError("gx", "validation", "gx-max is never used by GigPilot");
  return model;
}

export class GxProvider implements IntelligenceProvider {
  readonly family = "gx" as const;
  readonly paid = false;

  constructor(private readonly opts: GxOptions = {}) {}

  /** Bind tenant credentials (tenant GX_API_KEY secret → env). */
  withTenant(tenantId: string | null): GxProvider {
    return new GxProvider({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean(setting("GX_BASE_URL") && envValue("GX_API_KEY"));
  }

  /** Tenant-aware configuration check (tenant secret → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(this.baseUrl() && (await resolveCredential("gx", "GX_API_KEY", tenantId ?? this.opts.tenantId ?? null)));
  }

  supports(task: IntelligenceTask): boolean {
    // No web access: web_research is out; market_research works on provided data (requests with webSearch are refused in complete()).
    return task !== "web_research";
  }

  estimateCost(_req: IntelligenceRequest): number {
    return 0;
  }

  /** True when the task runs on the heavy shared model (gx-code). */
  static isHeavyTask(task: IntelligenceTask): boolean {
    return isHeavyGxTask(task);
  }

  /** Model id for a task (never gx-max). */
  modelFor(task: IntelligenceTask): string {
    if (this.opts.model) return assertNotMax(this.opts.model);
    return assertNotMax(FAST_TASKS.has(task) ? setting("GX_MODEL_FAST") : setting("GX_MODEL_CODE"));
  }

  private baseUrl(): string | undefined {
    const raw = setting("GX_BASE_URL");
    return raw ? raw.replace(/\/+$/, "") : undefined;
  }

  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    const started = Date.now();
    if (req.webSearch) throw new ProviderError("gx", "unsupported", "GX has no web search; route web research to Grok");
    const base = this.baseUrl();
    const tenantId = this.opts.tenantId ?? req.context?.tenantId ?? null;
    const key = await resolveCredential("gx", "GX_API_KEY", tenantId);
    if (!base || !key) throw new ProviderError("gx", "not_configured", "GX_BASE_URL and GX_API_KEY are required");
    const model = this.modelFor(req.task);

    const structured = Boolean(req.schema);
    const schemaName = schemaNameFor(req.schema, req.schemaName);
    const jsonSchema = req.schema ? jsonSchemaFor(req.schema) : undefined;
    const system = jsonSchema ? structuredSystemPrompt(schemaName, jsonSchema, schemaGuide(req.schema, req.schemaName)) : undefined;
    let messages = mergeSystemMessages(req.messages, system);
    const maxTokens = req.maxOutputTokens ?? defaultMaxTokens(req.task, structured);
    const temperature = req.temperature ?? (structured ? 0.2 : 0.5);

    let inputTokens = 0;
    let outputTokens = 0;
    let lastText = "";
    let answeredModel = model;
    const attempts = structured ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const res = await this.chat({ base, key, model, messages, maxTokens, temperature, schemaName, jsonSchema, signal: req.signal, priority: gxTaskPriority(req.task) });
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      lastText = res.text;
      answeredModel = res.model ?? model;
      if (!req.schema) {
        return { family: "gx", model: answeredModel, text: res.text, usage: { inputTokens, outputTokens, costUsd: 0, costSource: "free" }, latencyMs: Date.now() - started };
      }
      const outcome = parseAndValidate(req.schema, res.text, (v) => normalizeStructured(req.schema, v));
      if (outcome.ok) {
        return {
          family: "gx",
          model: answeredModel,
          text: res.text,
          data: outcome.data,
          usage: { inputTokens, outputTokens, costUsd: 0, costSource: "free" },
          latencyMs: Date.now() - started,
        };
      }
      const issues = res.finishReason === "length" ? [`output was truncated at ${maxTokens} tokens — be more concise`, ...outcome.issues] : outcome.issues;
      if (attempt + 1 < attempts) messages = repairMessages(messages, res.text, issues, schemaName);
      else
        throw new ProviderError("gx", "structured_output", `${model} output failed ${schemaName} validation after one repair: ${issues.slice(0, 5).join("; ")}`, {
          meta: { inputTokens, outputTokens, sample: lastText.slice(0, 400) },
        });
    }
    throw new ProviderError("gx", "structured_output", "unreachable");
  }

  private async chat(p: {
    base: string;
    key: string;
    model: string;
    messages: IntelligenceMessage[];
    maxTokens: number;
    temperature: number;
    schemaName: string;
    jsonSchema?: Record<string, unknown>;
    signal?: AbortSignal;
    priority?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; model?: string; finishReason?: string }> {
    let level: FormatLevel = p.jsonSchema ? (formatSupport.get(p.model) ?? "json_schema") : "none";
    for (;;) {
      const body: Record<string, unknown> = { model: p.model, messages: p.messages, max_tokens: p.maxTokens, temperature: p.temperature, stream: false };
      if (level === "json_schema" && p.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: p.schemaName, schema: p.jsonSchema, strict: true } };
      else if (level === "json_object") body.response_format = { type: "json_object" };

      const heavy = p.model !== setting("GX_MODEL_FAST");
      const waitOpts = { priority: p.priority ?? 2, timeoutMs: setting("GX_ACQUIRE_TIMEOUT_MS") };
      const slotError = (err: unknown, what: string) =>
        new ProviderError("gx", "timeout", err instanceof SemaphoreTimeoutError ? `${err.message} (${what}) — GX is saturated` : `aborted while waiting for ${what}`);
      const releaseHeavy = heavy
        ? await heavySlots.acquire(p.signal, waitOpts).catch((err: unknown) => {
            throw slotError(err, "a gx-code slot");
          })
        : () => {};
      const releaseSlot = await slots.acquire(p.signal, waitOpts).catch((err: unknown) => {
        releaseHeavy();
        throw slotError(err, "a GX slot");
      });
      const release = () => {
        releaseSlot();
        releaseHeavy();
      };
      let res;
      try {
        res = await safeFetch(
          `${p.base}/chat/completions`,
          { method: "POST", headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" }, body: JSON.stringify(body) },
          // Chat completions have no side effects → safe to retry transient gateway errors once.
          { timeoutMs: setting("GX_TIMEOUT_MS"), retries: 1, idempotent: true, maxBytes: 8 * 1024 * 1024, fetch: this.opts.fetch, signal: p.signal, redact: [p.key] },
        );
      } catch (err) {
        throw toProviderError(err, p.key);
      } finally {
        release();
      }

      if (res.status === 400 && level !== "none") {
        const snippet = bodySnippet(res, [p.key]).toLowerCase();
        if (/response_format|json_schema|grammar|schema|format/.test(snippet)) {
          level = level === "json_schema" ? "json_object" : "none";
          formatSupport.set(p.model, level);
          continue;
        }
      }
      if (!res.ok) {
        const code = codeForStatus(res.status);
        throw new ProviderError("gx", code, `gateway returned HTTP ${res.status}: ${bodySnippet(res, [p.key])}`, { status: res.status });
      }
      let data: ChatCompletion;
      try {
        data = res.json<ChatCompletion>();
      } catch (err) {
        throw new ProviderError("gx", "bad_response", err instanceof Error ? err.message : "invalid JSON from gateway");
      }
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (typeof text !== "string") throw new ProviderError("gx", "bad_response", "gateway response has no message content");
      if (!text.trim() && !p.jsonSchema) throw new ProviderError("gx", "bad_response", "gateway returned an empty completion");
      return {
        text,
        inputTokens: Number(data.usage?.prompt_tokens ?? 0) || 0,
        outputTokens: Number(data.usage?.completion_tokens ?? 0) || 0,
        model: data.model,
        finishReason: choice?.finish_reason,
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const base = this.baseUrl();
    const key = await resolveCredential("gx", "GX_API_KEY", this.opts.tenantId ?? null);
    if (!base || !key) {
      const missing = [!base && "GX_BASE_URL", !key && "GX_API_KEY"].filter(Boolean).join(" and ");
      return { status: "needs_configuration", detail: `Set ${missing} to use the local GX cluster.`, checkedAt };
    }
    const started = Date.now();
    try {
      const res = await safeFetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } }, { timeoutMs: 8000, fetch: this.opts.fetch, redact: [key] });
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) return { status: "error", detail: "GX gateway rejected the key (HTTP " + res.status + ").", latencyMs, checkedAt };
      if (!res.ok) return { status: "unavailable", detail: `GX gateway returned HTTP ${res.status}.`, latencyMs, checkedAt };
      const data = res.json<{ data?: { id?: string }[] }>();
      const models = (data.data ?? []).map((m) => m.id).filter((m): m is string => typeof m === "string" && !/gx-max/i.test(m));
      const needed = [setting("GX_MODEL_FAST"), setting("GX_MODEL_CODE")];
      const missing = needed.filter((m) => !models.includes(m));
      const meta = { models, keySource: credentialSource("GX_API_KEY", key), maxConcurrency: setting("GX_MAX_CONCURRENCY"), inFlight: slots.inFlight, queued: slots.queued };
      if (missing.length) return { status: "degraded", detail: `GX gateway reachable but missing model(s): ${missing.join(", ")}.`, latencyMs, checkedAt, meta };
      return { status: "connected", detail: `GX gateway reachable — ${models.length} model(s) available.`, latencyMs, checkedAt, meta };
    } catch (err) {
      const e = toProviderError(err, key);
      return { status: "unavailable", detail: e.message, latencyMs: Date.now() - started, checkedAt };
    }
  }
}

function toProviderError(err: unknown, key: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HttpError) {
    const code = err.code === "timeout" ? "timeout" : err.code === "aborted" ? "timeout" : "unavailable";
    return new ProviderError("gx", code, err.message.split(key).join("[redacted]"));
  }
  return new ProviderError("gx", "unavailable", "GX request failed");
}

/** Test helper: forget remembered response_format fallbacks. */
export function resetGxFormatSupport(): void {
  formatSupport.clear();
}
