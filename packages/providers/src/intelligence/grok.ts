import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";
import { GROK_WEB_SEARCH_PER_CALL_USD, inferenceCostUsd } from "@gigpilot/economics";
import { envValue, setting } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError, codeForStatus } from "../lib/errors";
import { HttpError, bodySnippet, redactText, safeFetch, type FetchLike } from "../lib/http";
import { estimateTokens, jsonSchemaFor, mergeSystemMessages, messagesText, parseAndValidate, repairMessages } from "../lib/structured";
import type { IntelligenceMessage } from "@gigpilot/contracts";
import { normalizeStructured, schemaGuide, schemaNameFor } from "./prompts";

/**
 * xAI / Grok adapter — Responses API `POST {XAI_BASE_URL}/responses`.
 *
 *  - Web research: server-side tools `web_search` (+ `x_search` for market
 *    research) when `req.webSearch`; tool turns bounded by `max_turns`.
 *    The deprecated Live Search `search_parameters` and the retired
 *    `grok-*-fast` slugs are never used.
 *  - Structured output: `text.format = {type:"json_schema", name, schema,
 *    strict:true}` + zod validation; one repair only if it fits `maxCostUsd`.
 *  - Model: XAI_MODEL (grok-4.3, cheap tier) by default; XAI_MODEL_PREMIUM
 *    (grok-4.7) only for qa_high where judgement quality matters most.
 *  - Cost: `usage.cost_in_usd_ticks / 1e10` (costSource "provider"), else the
 *    catalog token rate + $0.005 per web search call (costSource "catalog").
 *  - Citations: `citations` (strings or {url,title}) + url_citation annotations.
 *
 * Credentials (package-wide approach, see lib/credentials.ts): XAI_API_KEY per
 * call from the bound tenant (`withTenant`) or `req.context.tenantId` (tenant
 * secret) → env. `isConfigured()` = env XAI_API_KEY.
 */

const ALLOWED_HOSTS = ["api.x.ai", "*.api.x.ai"];
const WEB_SEARCH_CALLS_ESTIMATE = 4;
const MAX_TOOL_TURNS = 5;

export interface GrokOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
}

interface ResponsesOutputItem {
  type?: string;
  content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
}

interface ResponsesBody {
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  output_text?: string;
  citations?: (string | { url?: string; title?: string })[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_in_usd_ticks?: number;
    num_server_side_tools_used?: number;
    server_side_tool_usage_details?: Record<string, number>;
  };
  error?: { message?: string; code?: string } | string;
  incomplete_details?: { reason?: string };
}

export class GrokProvider implements IntelligenceProvider {
  readonly family = "grok" as const;
  readonly paid = true;

  constructor(private readonly opts: GrokOptions = {}) {}

  withTenant(tenantId: string | null): GrokProvider {
    return new GrokProvider({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean(envValue("XAI_API_KEY"));
  }

  /** Tenant-aware configuration check (tenant secret → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await resolveCredential("grok", "XAI_API_KEY", tenantId ?? this.opts.tenantId ?? null));
  }

  supports(_task: IntelligenceTask): boolean {
    return true;
  }

  modelFor(task: IntelligenceTask): string {
    return task === "qa_high" ? setting("XAI_MODEL_PREMIUM") : setting("XAI_MODEL");
  }

  private base(): string {
    return (setting("XAI_BASE_URL") || "https://api.x.ai/v1").replace(/\/+$/, "");
  }

  estimateCost(req: IntelligenceRequest): number {
    const model = this.modelFor(req.task);
    const schemaTok = req.schema ? estimateTokens(JSON.stringify(jsonSchemaFor(req.schema))) : 0;
    const inTok = estimateTokens(messagesText(req.messages)) + schemaTok + (req.webSearch ? 6000 : 0); // search results are fed back as input
    const outTok = req.maxOutputTokens ?? 2000;
    const tokens = inferenceCostUsd("grok", model, inTok, outTok) ?? 0;
    return tokens + (req.webSearch ? WEB_SEARCH_CALLS_ESTIMATE * GROK_WEB_SEARCH_PER_CALL_USD : 0);
  }

  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    const started = Date.now();
    const tenantId = this.opts.tenantId ?? req.context?.tenantId ?? null;
    const key = await resolveCredential("grok", "XAI_API_KEY", tenantId);
    if (!key) throw new ProviderError("grok", "not_configured", "XAI_API_KEY is not set");
    const estimate = this.estimateCost(req);
    if (req.maxCostUsd !== undefined && estimate > req.maxCostUsd) {
      throw new ProviderError("grok", "budget_exceeded", `estimated $${estimate.toFixed(4)} exceeds the call limit $${req.maxCostUsd.toFixed(4)}`);
    }
    const model = this.modelFor(req.task);
    const schemaName = schemaNameFor(req.schema, req.schemaName);
    const guide = req.schema ? schemaGuide(req.schema, req.schemaName) : undefined;
    let messages = mergeSystemMessages(req.messages, guide);

    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let costSource: "provider" | "catalog" = "provider";
    const citations = new Map<string, { url: string; title?: string }>();
    const attempts = req.schema ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const r = await this.call(key, model, messages, req);
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      costUsd += r.costUsd;
      if (r.costSource === "catalog") costSource = "catalog";
      for (const c of r.citations) if (!citations.has(c.url)) citations.set(c.url, c);
      const base = { family: "grok" as const, model: r.model ?? model, text: r.text, latencyMs: Date.now() - started, citations: citations.size ? [...citations.values()] : undefined };
      if (!req.schema) return { ...base, usage: { inputTokens, outputTokens, costUsd, costSource } };
      const outcome = parseAndValidate(req.schema, r.text, (v) => normalizeStructured(req.schema, v));
      if (outcome.ok) return { ...base, data: outcome.data, usage: { inputTokens, outputTokens, costUsd, costSource } };
      const canRepair = attempt + 1 < attempts && (req.maxCostUsd === undefined || costUsd * 2 <= req.maxCostUsd);
      if (!canRepair) {
        throw new ProviderError("grok", "structured_output", `output failed ${schemaName} validation${attempt ? " after one repair" : ""}: ${outcome.issues.slice(0, 5).join("; ")}`, {
          meta: { inputTokens, outputTokens, costUsd, costSource },
        });
      }
      messages = repairMessages(messages, r.text, outcome.issues, schemaName);
    }
    throw new ProviderError("grok", "structured_output", "unreachable");
  }

  private async call(
    key: string,
    model: string,
    messages: IntelligenceMessage[],
    req: IntelligenceRequest<unknown>,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; costUsd: number; costSource: "provider" | "catalog"; citations: { url: string; title?: string }[]; model?: string }> {
    const body: Record<string, unknown> = {
      model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: req.maxOutputTokens ?? 2000,
      store: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.webSearch) {
      body.tools = req.task === "market_research" ? [{ type: "web_search" }, { type: "x_search" }] : [{ type: "web_search" }];
      body.max_turns = MAX_TOOL_TURNS;
    }
    if (req.schema) {
      body.text = { format: { type: "json_schema", name: schemaNameFor(req.schema, req.schemaName), schema: jsonSchemaFor(req.schema), strict: true } };
      body.include = ["no_inline_citations"];
    }
    let res;
    try {
      res = await safeFetch(
        `${this.base()}/responses`,
        { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) },
        // Paid call: retry ONLY when the API definitively rejected it (429) — never after an ambiguous timeout.
        { timeoutMs: req.webSearch ? 240_000 : 120_000, retries: 1, retryOn: (i) => i.status === 429, allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, signal: req.signal, redact: [key], maxBytes: 8 * 1024 * 1024 },
      );
    } catch (err) {
      if (err instanceof HttpError) throw new ProviderError("grok", err.code === "timeout" ? "timeout" : "unavailable", err.message);
      throw err;
    }
    if (!res.ok) {
      const detail = bodySnippet(res, [key]);
      throw new ProviderError("grok", codeForStatus(res.status), `xAI returned HTTP ${res.status}: ${detail}`, { status: res.status });
    }
    let data: ResponsesBody;
    try {
      data = res.json<ResponsesBody>();
    } catch (err) {
      throw new ProviderError("grok", "bad_response", err instanceof Error ? err.message : "invalid JSON");
    }
    if (data.error) {
      const msg = typeof data.error === "string" ? data.error : (data.error.message ?? "unknown error");
      throw new ProviderError("grok", "provider_error", `xAI error: ${redactText(msg, [key]).slice(0, 240)}`);
    }
    const text = extractOutputText(data);
    const usage = data.usage ?? {};
    const inputTokens = Number(usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? 0) || 0;
    const ticks = Number(usage.cost_in_usd_ticks);
    let costUsd: number;
    let costSource: "provider" | "catalog";
    if (Number.isFinite(ticks) && ticks >= 0 && usage.cost_in_usd_ticks !== undefined && usage.cost_in_usd_ticks !== null) {
      costUsd = ticks / 1e10;
      costSource = "provider";
    } else {
      const searchCalls = countSearchCalls(data);
      costUsd = (inferenceCostUsd("grok", model, inputTokens, outputTokens) ?? 0) + searchCalls * GROK_WEB_SEARCH_PER_CALL_USD;
      costSource = "catalog";
    }
    if (!text.trim()) throw new ProviderError("grok", "bad_response", `xAI returned no output text${data.incomplete_details?.reason ? ` (${data.incomplete_details.reason})` : ""}`, { meta: { costUsd } });
    return { text, inputTokens, outputTokens, costUsd, costSource, citations: extractCitations(data), model: data.model };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const key = await resolveCredential("grok", "XAI_API_KEY", this.opts.tenantId ?? null);
    if (!key) return { status: "needs_configuration", detail: "Set XAI_API_KEY (console.x.ai) to enable Grok web research.", checkedAt };
    const started = Date.now();
    try {
      // Zero-cost: key metadata only.
      const res = await safeFetch(`${this.base()}/api-key`, { headers: { authorization: `Bearer ${key}` } }, { timeoutMs: 10_000, retries: 1, allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: [key] });
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) return { status: "error", detail: `xAI rejected the API key (HTTP ${res.status}).`, latencyMs, checkedAt };
      if (!res.ok) return { status: "unavailable", detail: `xAI returned HTTP ${res.status}.`, latencyMs, checkedAt };
      const info = res.json<{ name?: string; api_key_blocked?: boolean; api_key_disabled?: boolean; team_blocked?: boolean; acls?: string[] }>();
      const meta = {
        keyName: typeof info.name === "string" ? info.name.slice(0, 60) : undefined,
        apiKeyBlocked: Boolean(info.api_key_blocked),
        apiKeyDisabled: Boolean(info.api_key_disabled),
        teamBlocked: Boolean(info.team_blocked),
        keySource: credentialSource("XAI_API_KEY", key),
        model: setting("XAI_MODEL"),
        premiumModel: setting("XAI_MODEL_PREMIUM"),
      };
      if (meta.apiKeyBlocked || meta.apiKeyDisabled || meta.teamBlocked) {
        const flags = [meta.apiKeyBlocked && "key blocked", meta.apiKeyDisabled && "key disabled", meta.teamBlocked && "team blocked"].filter(Boolean).join(", ");
        return { status: "error", detail: `xAI key is not usable (${flags}).`, latencyMs, checkedAt, meta };
      }
      return { status: "connected", detail: "xAI API key valid.", latencyMs, checkedAt, meta };
    } catch (err) {
      return { status: "unavailable", detail: err instanceof Error ? err.message : "xAI health check failed", latencyMs: Date.now() - started, checkedAt };
    }
  }
}

export function extractOutputText(data: ResponsesBody): string {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("");
}

export function extractCitations(data: ResponsesBody): { url: string; title?: string }[] {
  const out = new Map<string, { url: string; title?: string }>();
  for (const c of data.citations ?? []) {
    if (typeof c === "string") out.set(c, { url: c });
    else if (c && typeof c.url === "string") out.set(c.url, { url: c.url, title: c.title });
  }
  for (const item of data.output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && typeof a.url === "string" && !out.has(a.url)) out.set(a.url, { url: a.url, title: a.title });
      }
    }
  }
  return [...out.values()].filter((c) => /^https?:\/\//i.test(c.url));
}

function countSearchCalls(data: ResponsesBody): number {
  const details = data.usage?.server_side_tool_usage_details;
  if (details && typeof details === "object") {
    const n = Object.entries(details)
      .filter(([k]) => /search/i.test(k))
      .reduce((s, [, v]) => s + (Number(v) || 0), 0);
    if (n > 0) return n;
  }
  return (data.output ?? []).filter((o) => typeof o.type === "string" && /search_call$/.test(o.type)).length;
}
