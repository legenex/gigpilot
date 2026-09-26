import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import { catalogCost } from "../lib/cost";
import { envValue, intEnv, setting } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError, type ProviderErrorCode } from "../lib/errors";
import { HttpError, bodySnippet, redactText, safeFetch, type FetchLike, type LookupFn, type SafeResponse } from "../lib/http";
import { downloadMedia } from "../lib/media";

/**
 * Kie.ai adapter (unified Market jobs API).
 *
 *  - Create: `POST {KIE_BASE_URL}/api/v1/jobs/createTask` {model, input}.
 *    Not idempotent → retried only on HTTP 429 (definitively rejected).
 *  - Poll: `GET /api/v1/jobs/recordInfo?taskId=` every 2.5 s with backoff to
 *    15 s until KIE_POLL_TIMEOUT_MS (default 15 min). `resultJson` is a JSON
 *    STRING (`{"resultUrls":[...]}`) — parsed defensively (string or object).
 *  - Errors: HTTP status AND envelope `code` are both checked (401/402/404/
 *    408/422/429/433/455/500/501/505 mapped to ProviderError codes).
 *  - Results are downloaded immediately (SSRF-guarded, size-capped) and
 *    returned as bytes — provider URLs expire.
 *  - Cost: `creditsConsumed × $0.005` (costSource "provider"), else catalog.
 *
 * Credentials (package-wide approach, see lib/credentials.ts): KIE_API_KEY per
 * call from the bound tenant (`withTenant`) or `req.context.tenantId` (tenant
 * secret) → env. `isConfigured()` = env KIE_API_KEY.
 *
 * Throws ProviderError when nothing was spent; returns `status:"failed"` when a
 * submitted task fails (failed generations are refunded by Kie → cost 0).
 */

export const KIE_CREDIT_USD = 0.005;
const ALLOWED_HOSTS = ["api.kie.ai", "*.kie.ai"];

type Aspect = NonNullable<CreativeRequest["aspectRatio"]>;

export interface KieOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
  lookup?: LookupFn;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface KieEnvelope<T> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
}

interface KieRecord {
  taskId?: string;
  model?: string;
  state?: string;
  resultJson?: string | { resultUrls?: string[]; resultObject?: unknown } | null;
  failCode?: string | number | null;
  failMsg?: string | null;
  creditsConsumed?: number | string | null;
  costTime?: number;
}

const ENVELOPE_CODES: Record<number, { code: ProviderErrorCode; message: string }> = {
  401: { code: "auth", message: "authentication failed (check KIE_API_KEY)" },
  402: { code: "insufficient_credits", message: "insufficient Kie credits" },
  404: { code: "not_found", message: "resource not found" },
  408: { code: "timeout", message: "upstream timeout" },
  422: { code: "validation", message: "request validation failed" },
  429: { code: "rate_limited", message: "rate limited (20 creates / 10 s)" },
  433: { code: "rate_limited", message: "sub-key usage limit reached" },
  455: { code: "unavailable", message: "service under maintenance" },
  500: { code: "provider_error", message: "Kie server error" },
  501: { code: "generation_failed", message: "generation failed" },
  505: { code: "unavailable", message: "feature disabled for this account" },
};

/** Map GigPilot's aspect ratio onto a model's supported set. */
function mapAspect(value: Aspect | undefined, allowed: readonly string[], map: Partial<Record<Aspect, string>>, fallback: string): string {
  if (!value) return fallback;
  if (allowed.includes(value)) return value;
  return map[value] ?? fallback;
}

function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Map a GigPilot request to the model-specific Kie `input` (fields per the
 * official model pages, read 2026-09-26). `req.params.input` (object) is
 * merged last as an explicit escape hatch.
 */
export function buildKieInput(model: string, req: CreativeRequest): Record<string, unknown> {
  const refs = (req.referenceAssetUrls ?? []).filter((u) => /^https:\/\//i.test(u));
  const p = req.params ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  let input: Record<string, unknown>;
  switch (model) {
    case "nano-banana-2":
      input = {
        prompt: req.prompt,
        image_input: refs.slice(0, 14),
        aspect_ratio: mapAspect(req.aspectRatio, ["1:1", "4:5", "9:16", "16:9", "3:2"], {}, "1:1"),
        resolution: ["1K", "2K", "4K"].includes(str("resolution") ?? "") ? str("resolution") : "1K",
        output_format: "png",
      };
      break;
    case "google/imagen4-fast":
      input = {
        prompt: req.prompt,
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
        aspect_ratio: mapAspect(req.aspectRatio, ["1:1", "16:9", "9:16"], { "4:5": "3:4", "3:2": "4:3" }, "1:1"),
      };
      break;
    case "gpt-image-2-text-to-image":
      input = {
        prompt: req.prompt,
        aspect_ratio: mapAspect(req.aspectRatio, ["1:1", "4:5", "9:16", "16:9", "3:2"], {}, "1:1"),
        resolution: ["1K", "2K", "4K"].includes(str("resolution") ?? "") ? str("resolution") : "1K",
      };
      break;
    case "google/nano-banana-edit": {
      if (!refs.length) throw new ProviderError("kie", "validation", "google/nano-banana-edit needs at least one https reference image");
      const ar = mapAspect(req.aspectRatio, ["1:1", "4:5", "9:16", "16:9", "3:2"], {}, "1:1");
      input = { prompt: req.prompt, image_urls: refs.slice(0, 10), output_format: "png", aspect_ratio: ar, image_size: ar };
      break;
    }
    case "veo-3-1": {
      const d = req.durationSec ?? 8;
      const duration = [4, 6, 8].find((x) => x >= d) ?? 8;
      input = {
        prompt: req.prompt,
        aspect_ratio: mapAspect(req.aspectRatio, ["16:9", "9:16"], { "4:5": "9:16", "3:2": "16:9", "1:1": "16:9" }, "16:9"),
        resolution: ["720p", "1080p", "4k"].includes(str("resolution") ?? "") ? str("resolution") : "720p",
        duration,
        ...(refs.length ? { image_urls: refs.slice(0, 2), generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO" } : { generation_type: "TEXT_2_VIDEO" }),
      };
      break;
    }
    case "kling-3.0/video":
      input = {
        prompt: req.prompt,
        ...(refs.length ? { image_urls: refs.slice(0, 2) } : {}),
        sound: false,
        duration: String(clampInt(req.durationSec, 3, 15, 5)),
        aspect_ratio: mapAspect(req.aspectRatio, ["16:9", "9:16", "1:1"], { "4:5": "9:16", "3:2": "16:9" }, "16:9"),
        mode: str("mode") === "pro" ? "pro" : "std",
      };
      break;
    case "bytedance/seedance-2-fast":
      input = {
        prompt: req.prompt,
        ...(refs[0] ? { first_frame_url: refs[0] } : {}),
        resolution: str("resolution") === "720p" ? "720p" : "480p",
        aspect_ratio: mapAspect(req.aspectRatio, ["1:1", "16:9", "9:16"], { "4:5": "3:4", "3:2": "4:3" }, "16:9"),
        duration: clampInt(req.durationSec, 4, 15, 5),
        generate_audio: p.generateAudio === true,
      };
      break;
    case "topaz/image-upscale":
      // UNCERTAIN: field names not captured in research; pass the first reference as image_url.
      if (!refs.length) throw new ProviderError("kie", "validation", "topaz/image-upscale needs a https reference image");
      input = { image_url: refs[0], ...(typeof p.upscaleFactor === "number" ? { upscale_factor: String(p.upscaleFactor) } : {}) };
      break;
    default:
      input = { prompt: req.prompt, ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}), ...(refs.length ? { image_urls: refs } : {}) };
  }
  if (p.input && typeof p.input === "object" && !Array.isArray(p.input)) input = { ...input, ...(p.input as Record<string, unknown>) };
  return input;
}

/** Parse Kie's `resultJson` (usually a JSON string) into result URLs. */
export function parseKieResultUrls(resultJson: KieRecord["resultJson"]): string[] {
  if (!resultJson) return [];
  let obj: unknown = resultJson;
  if (typeof resultJson === "string") {
    try {
      obj = JSON.parse(resultJson);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const urls = o.resultUrls ?? (o.resultObject as Record<string, unknown> | undefined)?.resultUrls ?? o.urls;
  if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  if (typeof o.resultUrl === "string") return [o.resultUrl];
  return [];
}

export function kieCreditsToUsd(credits: unknown): number | undefined {
  const n = typeof credits === "string" ? Number(credits) : typeof credits === "number" ? credits : NaN;
  return Number.isFinite(n) && n >= 0 ? n * KIE_CREDIT_USD : undefined;
}

export class KieProvider implements CreativeProvider {
  readonly key = "kie";
  readonly paid = true;

  constructor(private readonly opts: KieOptions = {}) {}

  withTenant(tenantId: string | null): KieProvider {
    return new KieProvider({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean(envValue("KIE_API_KEY"));
  }

  /** Tenant-aware configuration check (tenant secret → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await resolveCredential("kie", "KIE_API_KEY", tenantId ?? this.opts.tenantId ?? null));
  }

  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === "kie");
  }

  private base(): string {
    return (setting("KIE_BASE_URL") || "https://api.kie.ai").replace(/\/+$/, "");
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return abortableSleep(ms, signal);
  }

  private envelopeError(res: SafeResponse, key: string, env?: KieEnvelope<unknown>): ProviderError | undefined {
    const code = env?.code ?? (res.ok ? 200 : res.status);
    if (res.ok && code === 200) return undefined;
    const mapped = ENVELOPE_CODES[code] ?? ENVELOPE_CODES[res.status];
    const msg = redactText(String(env?.msg ?? env?.message ?? bodySnippet(res, [key])), [key]).slice(0, 200);
    return new ProviderError("kie", mapped?.code ?? "provider_error", `${mapped?.message ?? `HTTP ${res.status}`} (code ${code}): ${msg}`, { status: res.status });
  }

  async generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    const started = Date.now();
    if (option.provider !== "kie") throw new ProviderError("kie", "validation", `option belongs to ${option.provider}`);
    const tenantId = this.opts.tenantId ?? req.context?.tenantId ?? null;
    const key = await resolveCredential("kie", "KIE_API_KEY", tenantId);
    if (!key) throw new ProviderError("kie", "not_configured", "KIE_API_KEY is not set");
    const estimate = catalogCost(option, req.durationSec);
    if (estimate === null && req.params?.allowUnknownPrice !== true) throw new ProviderError("kie", "budget_exceeded", `price for ${option.model} is unknown — cannot enforce maxCostUsd`);
    if (estimate !== null && estimate > req.maxCostUsd) throw new ProviderError("kie", "budget_exceeded", `estimated $${estimate.toFixed(4)} exceeds maxCostUsd $${req.maxCostUsd.toFixed(4)}`);

    const input = buildKieInput(option.model, req);
    const signal = req.signal;
    const http = { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: [key], signal };
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    if (signal?.aborted) throw new ProviderError("kie", "timeout", "aborted before submission — nothing was sent");

    // --- create (never retried after ambiguity) ---
    let createRes: SafeResponse;
    try {
      createRes = await safeFetch(`${this.base()}/api/v1/jobs/createTask`, { method: "POST", headers, body: JSON.stringify({ model: option.model, input }) }, { ...http, timeoutMs: 30_000, retries: 1, retryOn: (i) => i.status === 429 });
    } catch (err) {
      if (err instanceof HttpError && (err.code === "timeout" || err.code === "aborted")) {
        throw new ProviderError("kie", "ambiguous_submission", `createTask ${err.code === "aborted" ? "was interrupted" : "timed out"} — the task may exist; verify on Kie before retrying (not retried automatically)`, { retryable: false });
      }
      throw new ProviderError("kie", "unavailable", err instanceof Error ? err.message : "createTask failed");
    }
    let created: KieEnvelope<{ taskId?: string }>;
    try {
      created = createRes.json();
    } catch (err) {
      throw this.envelopeError(createRes, key) ?? new ProviderError("kie", "bad_response", err instanceof Error ? err.message : "invalid JSON");
    }
    const createErr = this.envelopeError(createRes, key, created);
    if (createErr) throw createErr;
    const taskId = created.data?.taskId;
    if (!taskId || typeof taskId !== "string") throw new ProviderError("kie", "bad_response", "createTask response has no taskId");

    // --- poll ---
    const timeoutMs = this.opts.pollTimeoutMs ?? intEnv("KIE_POLL_TIMEOUT_MS", 15 * 60_000, 10_000);
    let interval = this.opts.pollIntervalMs ?? 2500;
    const maxInterval = this.opts.pollMaxIntervalMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let record: KieRecord | undefined;
    let transientFailures = 0;
    const pendingFailure = (why: string): CreativeOutput => ({
      provider: "kie",
      model: option.model,
      status: "failed",
      files: [],
      externalTaskId: taskId,
      costUsd: estimate ?? 0,
      costSource: estimate === null ? "unknown" : "catalog",
      latencyMs: Date.now() - started,
      error: `${why} waiting for task ${taskId} (it may still complete and be billed)`,
    });
    for (;;) {
      await this.sleep(interval, signal);
      if (signal?.aborted) return pendingFailure("aborted");
      interval = Math.min(maxInterval, Math.round(interval * 1.3));
      try {
        const res = await safeFetch(`${this.base()}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${key}` } }, { ...http, timeoutMs: 20_000, retries: 2 });
        const env = res.json<KieEnvelope<KieRecord>>();
        const err = this.envelopeError(res, key, env);
        if (err) {
          if (err.code === "auth" || err.code === "not_found" || err.code === "validation") throw err;
          throw new HttpError("network", err.message);
        }
        record = env.data;
        transientFailures = 0;
      } catch (err) {
        if (signal?.aborted) return pendingFailure("aborted");
        if (err instanceof ProviderError) throw err;
        if (++transientFailures >= 5) throw new ProviderError("kie", "unavailable", `polling task ${taskId} failed repeatedly: ${err instanceof Error ? err.message : "unknown"}`, { meta: { taskId } });
      }
      const state = record?.state;
      if (state === "success" || state === "fail") break;
      if (Date.now() >= deadline) return pendingFailure(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    }

    const creditsUsd = kieCreditsToUsd(record?.creditsConsumed);
    if (record?.state === "fail") {
      return {
        provider: "kie",
        model: option.model,
        status: "failed",
        files: [],
        externalTaskId: taskId,
        costUsd: creditsUsd ?? 0, // failed generations are refunded
        costSource: "provider",
        latencyMs: Date.now() - started,
        error: `generation failed${record.failCode ? ` [${record.failCode}]` : ""}: ${redactText(String(record.failMsg ?? "no reason given"), [key]).slice(0, 300)}`,
      };
    }

    const cost: Pick<CreativeOutput, "costUsd" | "costSource"> =
      creditsUsd !== undefined ? { costUsd: creditsUsd, costSource: "provider" } : estimate !== null ? { costUsd: estimate, costSource: "catalog" } : { costUsd: 0, costSource: "unknown" };
    const urls = parseKieResultUrls(record?.resultJson);
    if (!urls.length) {
      return { provider: "kie", model: option.model, status: "failed", files: [], externalTaskId: taskId, ...cost, latencyMs: Date.now() - started, error: "task succeeded but resultJson contained no result URLs" };
    }
    try {
      const isVideo = option.capability.startsWith("video.");
      const files = await downloadMedia(urls, {
        prefix: `kie-${option.model}-${taskId}`,
        maxBytes: isVideo ? 300 * 1024 * 1024 : 50 * 1024 * 1024,
        fetch: this.opts.fetch,
        lookup: this.opts.lookup,
        signal,
      });
      return { provider: "kie", model: option.model, status: "succeeded", files, externalTaskId: taskId, ...cost, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        provider: "kie",
        model: option.model,
        status: "failed",
        files: [],
        externalTaskId: taskId,
        ...cost,
        latencyMs: Date.now() - started,
        error: `result download failed: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const key = await resolveCredential("kie", "KIE_API_KEY", this.opts.tenantId ?? null);
    if (!key) return { status: "needs_configuration", detail: "Set KIE_API_KEY (kie.ai/api-key) to enable Kie generation.", checkedAt };
    const started = Date.now();
    try {
      const res = await safeFetch(`${this.base()}/api/v1/chat/credit`, { headers: { authorization: `Bearer ${key}` } }, { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: [key], timeoutMs: 10_000, retries: 1 });
      const latencyMs = Date.now() - started;
      let env: KieEnvelope<unknown> | undefined;
      try {
        env = res.json<KieEnvelope<unknown>>();
      } catch {
        env = undefined;
      }
      const err = this.envelopeError(res, key, env);
      if (err) return { status: err.code === "auth" ? "error" : "unavailable", detail: err.message, latencyMs, checkedAt };
      const credits = Number(env?.data);
      const meta = { credits: Number.isFinite(credits) ? credits : null, creditsUsd: Number.isFinite(credits) ? Math.round(credits * KIE_CREDIT_USD * 100) / 100 : null, keySource: credentialSource("KIE_API_KEY", key) };
      if (Number.isFinite(credits) && credits <= 0) return { status: "degraded", detail: "Kie key valid but the credit balance is 0.", latencyMs, checkedAt, meta };
      return { status: "connected", detail: `Kie key valid — ${Number.isFinite(credits) ? credits : "unknown"} credits available.`, latencyMs, checkedAt, meta };
    } catch (err) {
      return { status: "unavailable", detail: err instanceof Error ? err.message : "Kie health check failed", latencyMs: Date.now() - started, checkedAt };
    }
  }
}

/** setTimeout that resolves early when the signal aborts (callers re-check `signal.aborted`). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function header(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(hit) ? hit[0] : hit;
}

/**
 * Verify a Kie callback: `X-Webhook-Signature` = base64(HMAC-SHA256(taskId + "." +
 * X-Webhook-Timestamp, KIE_WEBHOOK_HMAC_KEY)). The task id may appear as
 * `taskId`/`task_id` at the top level or under `data` (docs disagree).
 * Rejects timestamps older/newer than `maxSkewSec` (replay protection).
 */
export function verifyKieWebhook(
  headers: Headers | Record<string, string | string[] | undefined>,
  body: string | Record<string, unknown>,
  hmacKey: string | undefined,
  opts: { maxSkewSec?: number; nowSec?: number } = {},
): { ok: boolean; taskId?: string; reason?: string } {
  if (!hmacKey) return { ok: false, reason: "KIE_WEBHOOK_HMAC_KEY is not configured" };
  const ts = header(headers, "x-webhook-timestamp");
  const sig = header(headers, "x-webhook-signature");
  if (!ts || !sig) return { ok: false, reason: "missing signature headers" };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: "invalid timestamp" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (opts.maxSkewSec ?? 300)) return { ok: false, reason: "timestamp outside the allowed window" };
  let obj: Record<string, unknown>;
  try {
    obj = typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : body;
  } catch {
    return { ok: false, reason: "invalid JSON body" };
  }
  const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>;
  const taskId = [obj.taskId, obj.task_id, data.taskId, data.task_id].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!taskId) return { ok: false, reason: "task id missing from body" };
  const expected = createHmac("sha256", hmacKey).update(`${taskId}.${ts}`).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig.trim());
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true, taskId } : { ok: false, taskId, reason: "signature mismatch" };
}
