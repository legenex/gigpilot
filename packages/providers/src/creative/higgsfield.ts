import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import { envValue, intEnv, setting } from "../lib/config";
import { credentialSource, resolveCredentials } from "../lib/credentials";
import { ProviderError } from "../lib/errors";
import { HttpError, bodySnippet, redactText, safeFetch, type FetchLike, type LookupFn, type SafeResponse } from "../lib/http";
import { downloadMedia } from "../lib/media";
import { catalogCost } from "../lib/cost";
import { abortableSleep } from "./kie";

/**
 * Higgsfield Cloud API adapter.
 *
 *  - Auth header `Authorization: Key {HIGGSFIELD_API_KEY}:{HIGGSFIELD_API_SECRET}`.
 *  - Cost pre-flight: free `POST /estimate/{endpoint}` with the same body; the
 *    job is refused when the estimate exceeds `maxCostUsd`. Status responses
 *    carry no cost, so the estimate is recorded as the cost with costSource
 *    "provider" (the value comes from the provider's own estimate endpoint —
 *    the contract enum has no "estimate" member).
 *  - Generate: `POST /{endpoint-id}` → request_id. NEVER auto-retried (no
 *    idempotency key): a timeout raises `ambiguous_submission`.
 *    400 with a concurrency message → `concurrency_limit` (retry later).
 *  - Poll `GET /requests/{id}/status` 2 s → 10 s with jitter until completed |
 *    failed | nsfw | canceled (HIGGSFIELD_POLL_TIMEOUT_MS, default 15 min).
 *  - Outputs (`images[].url`, `video.url`, `audio.url`) are downloaded to bytes.
 *
 * Endpoint ids: the catalog model id IS the endpoint id (e.g.
 * `higgsfield-ai/soul/v2/standard`). UNCERTAIN for z-image/turbo,
 * kling-video/v3.0/…, bytedance/seedance-2.5/… and marketing-studio/image —
 * verify in console.higgsfield.ai; override per request with
 * `params.endpoint` (validated) if an id differs.
 *
 * Credentials (package-wide approach, see lib/credentials.ts): key + secret
 * per call from the bound tenant (`withTenant`) or `req.context.tenantId`
 * (tenant secrets) → env. `isConfigured()` = env key AND secret.
 */

const ALLOWED_HOSTS = ["api.higgsfield.ai", "*.higgsfield.ai"];
const HEALTH_ENDPOINT = "higgsfield-ai/soul/v2/standard";
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled", "cancelled"]);

export interface HiggsfieldOptions {
  tenantId?: string | null;
  fetch?: FetchLike;
  lookup?: LookupFn;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface StatusBody {
  status?: string;
  request_id?: string;
  error?: string | null;
  images?: { url?: string }[];
  video?: { url?: string };
  audio?: { url?: string };
  audios?: { url?: string }[];
  detail?: unknown;
}

/** Endpoint id for a catalog option (validated; `params.endpoint` overrides). */
export function higgsfieldEndpoint(option: CreativeModelOption, req?: CreativeRequest): string {
  const override = req?.params?.endpoint;
  const id = typeof override === "string" && override ? override : option.model;
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,5}$/i.test(id) || id.includes("..")) throw new ProviderError("higgsfield", "validation", `invalid endpoint id "${id.slice(0, 80)}"`);
  return id;
}

/** Request body per capability (fields per the Higgsfield OpenAPI, read 2026-09-26). */
export function buildHiggsfieldBody(option: CreativeModelOption, req: CreativeRequest): Record<string, unknown> {
  const refs = (req.referenceAssetUrls ?? []).filter((u) => /^https:\/\//i.test(u));
  const p = req.params ?? {};
  let body: Record<string, unknown>;
  switch (option.capability) {
    case "image.generate":
      body = { prompt: req.prompt, ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}), ...(typeof p.resolution === "string" ? { resolution: p.resolution } : {}) };
      break;
    case "image.edit":
      if (!refs.length) throw new ProviderError("higgsfield", "validation", `${option.model} needs at least one https reference image`);
      body = { prompt: req.prompt, image_url: refs[0], ...(refs.length > 1 ? { image_urls: refs.slice(0, 8) } : {}), ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}) };
      break;
    case "video.image_to_video": {
      if (!refs.length) throw new ProviderError("higgsfield", "validation", `${option.model} needs a https start image`);
      const d = req.durationSec ?? 5;
      body = { prompt: req.prompt, image_url: refs[0], duration: d > 5 ? 10 : 5, ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}) };
      break;
    }
    case "video.generate": {
      const d = Math.round(req.durationSec ?? 5);
      body = { prompt: req.prompt, duration: Math.min(15, Math.max(4, d)), ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}), ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}) };
      break;
    }
    default:
      body = { prompt: req.prompt, ...(refs.length ? { image_url: refs[0] } : {}) };
  }
  if (p.input && typeof p.input === "object" && !Array.isArray(p.input)) body = { ...body, ...(p.input as Record<string, unknown>) };
  return body;
}

function detailOf(res: SafeResponse, secrets: string[]): string {
  return redactText(rawDetail(res, secrets), secrets);
}

function rawDetail(res: SafeResponse, secrets: string[]): string {
  try {
    const d = res.json<{ detail?: unknown }>().detail;
    if (typeof d === "string") return d.slice(0, 240);
    if (Array.isArray(d))
      return d
        .map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : JSON.stringify(x)))
        .join("; ")
        .slice(0, 240);
  } catch {
    /* fall through */
  }
  return bodySnippet(res, secrets);
}

export function mapHiggsfieldError(res: SafeResponse, secrets: string[], stage: "estimate" | "generate" | "status"): ProviderError {
  const detail = detailOf(res, secrets);
  const s = res.status;
  if (s === 401) return new ProviderError("higgsfield", "auth", `invalid credentials (${stage})`, { status: s });
  if (s === 403) return new ProviderError("higgsfield", "insufficient_credits", `insufficient credits: ${detail}`, { status: s });
  if (s === 400 && /concurren|parallel|simultaneous|too many (active|running)|limit reached/i.test(detail)) return new ProviderError("higgsfield", "concurrency_limit", `account concurrency limit reached: ${detail}`, { status: s });
  if (s === 400 || s === 422) return new ProviderError("higgsfield", "validation", `request rejected: ${detail}`, { status: s });
  if (s === 404) return new ProviderError("higgsfield", "not_found", `endpoint or request not found for this account: ${detail}`, { status: s });
  if (s === 423 || s === 503) return new ProviderError("higgsfield", "unavailable", `model temporarily unavailable: ${detail}`, { status: s });
  if (s === 429) return new ProviderError("higgsfield", "rate_limited", `rate limited: ${detail}`, { status: s });
  // 5xx on a generate POST is NOT retried automatically (no idempotency key).
  return new ProviderError("higgsfield", "provider_error", `HTTP ${s} (${stage}): ${detail}`, { status: s, retryable: stage !== "generate" });
}

export class HiggsfieldProvider implements CreativeProvider {
  readonly key = "higgsfield";
  readonly paid = true;

  constructor(private readonly opts: HiggsfieldOptions = {}) {}

  withTenant(tenantId: string | null): HiggsfieldProvider {
    return new HiggsfieldProvider({ ...this.opts, tenantId });
  }

  isConfigured(): boolean {
    return Boolean(envValue("HIGGSFIELD_API_KEY") && envValue("HIGGSFIELD_API_SECRET"));
  }

  /** Tenant-aware configuration check (tenant secrets → env). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await this.creds(tenantId ?? this.opts.tenantId ?? null));
  }

  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === "higgsfield");
  }

  private base(): string {
    return (setting("HIGGSFIELD_BASE_URL") || "https://api.higgsfield.ai").replace(/\/+$/, "");
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return abortableSleep(ms, signal);
  }

  private async creds(tenantId: string | null): Promise<{ key: string; secret: string } | undefined> {
    const c = await resolveCredentials("higgsfield", ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"] as const, tenantId);
    if (!c.HIGGSFIELD_API_KEY || !c.HIGGSFIELD_API_SECRET) return undefined;
    return { key: c.HIGGSFIELD_API_KEY, secret: c.HIGGSFIELD_API_SECRET };
  }

  /** Free pre-flight estimate (USD). */
  async estimate(endpoint: string, body: Record<string, unknown>, creds: { key: string; secret: string }): Promise<{ usd: number; credits?: number }> {
    const secrets = [creds.key, creds.secret];
    const res = await safeFetch(
      `${this.base()}/estimate/${endpoint}`,
      { method: "POST", headers: { authorization: `Key ${creds.key}:${creds.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) },
      // The estimate has no side effects → safe to retry transient failures.
      { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: secrets, timeoutMs: 15_000, retries: 2, idempotent: true },
    );
    if (!res.ok) throw mapHiggsfieldError(res, secrets, "estimate");
    const data = res.json<{ usd?: string | number; credits?: string | number }>();
    const usd = Number(data.usd);
    if (!Number.isFinite(usd) || usd < 0) throw new ProviderError("higgsfield", "bad_response", "estimate response has no usd value");
    const credits = Number(data.credits);
    return { usd, credits: Number.isFinite(credits) ? credits : undefined };
  }

  async generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    const started = Date.now();
    if (option.provider !== "higgsfield") throw new ProviderError("higgsfield", "validation", `option belongs to ${option.provider}`);
    const creds = await this.creds(this.opts.tenantId ?? req.context?.tenantId ?? null);
    if (!creds) throw new ProviderError("higgsfield", "not_configured", "HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET are required");
    const secrets = [creds.key, creds.secret];
    const endpoint = higgsfieldEndpoint(option, req);
    const body = buildHiggsfieldBody(option, req);
    const signal = req.signal;

    // --- free estimate → budget gate ---
    let costUsd: number;
    let costSource: CreativeOutput["costSource"] = "provider";
    try {
      costUsd = (await this.estimate(endpoint, body, creds)).usd;
    } catch (err) {
      if (err instanceof ProviderError && (err.code === "auth" || err.code === "insufficient_credits" || err.code === "validation")) throw err;
      const fallback = catalogCost(option, req.durationSec);
      if (fallback === null) throw new ProviderError("higgsfield", "budget_exceeded", `no estimate available for ${endpoint} and catalog price unknown — refusing to generate`);
      costUsd = fallback;
      costSource = "catalog";
    }
    if (costUsd > req.maxCostUsd) throw new ProviderError("higgsfield", "budget_exceeded", `estimated $${costUsd.toFixed(4)} exceeds maxCostUsd $${req.maxCostUsd.toFixed(4)}`);
    if (signal?.aborted) throw new ProviderError("higgsfield", "timeout", "aborted before submission — nothing was sent");

    // --- generate: exactly one attempt ---
    let res: SafeResponse;
    try {
      res = await safeFetch(
        `${this.base()}/${endpoint}`,
        { method: "POST", headers: { authorization: `Key ${creds.key}:${creds.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) },
        { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: secrets, timeoutMs: 60_000, retries: 0, idempotent: false, retryOn: () => false, signal },
      );
    } catch (err) {
      if (err instanceof HttpError && (err.code === "timeout" || err.code === "network" || err.code === "aborted")) {
        throw new ProviderError("higgsfield", "ambiguous_submission", "generate request outcome unknown (timeout/network) — NOT retried because Higgsfield has no idempotency key; check the Higgsfield console before retrying", { retryable: false });
      }
      throw new ProviderError("higgsfield", "unavailable", err instanceof Error ? err.message : "generate failed");
    }
    if (!res.ok) throw mapHiggsfieldError(res, secrets, "generate");
    let queued: StatusBody;
    try {
      queued = res.json<StatusBody>();
    } catch (err) {
      throw new ProviderError("higgsfield", "bad_response", err instanceof Error ? err.message : "invalid JSON", { meta: { note: "request may have been accepted" } });
    }
    const requestId = queued.request_id;
    if (!requestId || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new ProviderError("higgsfield", "bad_response", "generate response has no valid request_id");

    // --- poll ---
    const timeoutMs = this.opts.pollTimeoutMs ?? intEnv("HIGGSFIELD_POLL_TIMEOUT_MS", 15 * 60_000, 10_000);
    const deadline = Date.now() + timeoutMs;
    let delay = this.opts.pollIntervalMs ?? 2000;
    const maxDelay = this.opts.pollMaxIntervalMs ?? 10_000;
    let status: StatusBody = queued;
    let transient = 0;
    const pendingFailure = (why: string): CreativeOutput => ({
      provider: "higgsfield",
      model: option.model,
      status: "failed",
      files: [],
      externalTaskId: requestId,
      costUsd,
      costSource,
      latencyMs: Date.now() - started,
      error: `${why} waiting for request ${requestId} (it may still complete and be billed)`,
    });
    while (!TERMINAL.has(status.status ?? "")) {
      if (Date.now() >= deadline) return pendingFailure(`timed out after ${Math.round(timeoutMs / 1000)} s`);
      await this.sleep(delay + Math.random() * 500, signal);
      if (signal?.aborted) return pendingFailure("aborted");
      delay = Math.min(maxDelay, delay * 1.5);
      try {
        const s = await safeFetch(`${this.base()}/requests/${requestId}/status`, { headers: { authorization: `Key ${creds.key}:${creds.secret}` } }, { allowHosts: ALLOWED_HOSTS, fetch: this.opts.fetch, redact: secrets, timeoutMs: 20_000, retries: 2, signal });
        if (!s.ok) {
          const e = mapHiggsfieldError(s, secrets, "status");
          if (e.code === "auth" || e.code === "not_found") throw e;
          throw new HttpError("network", e.message);
        }
        status = s.json<StatusBody>();
        transient = 0;
      } catch (err) {
        if (signal?.aborted) return pendingFailure("aborted");
        if (err instanceof ProviderError) throw err;
        if (++transient >= 5) throw new ProviderError("higgsfield", "unavailable", `polling request ${requestId} failed repeatedly`, { meta: { requestId } });
      }
    }

    if (status.status !== "completed") {
      const reason = status.status === "nsfw" ? "content flagged as NSFW" : status.status === "failed" ? `generation failed: ${redactText(String(status.error ?? "no reason given"), secrets).slice(0, 300)}` : "request was canceled";
      // Failed / NSFW requests are not charged (reserved credits refunded).
      return { provider: "higgsfield", model: option.model, status: "failed", files: [], externalTaskId: requestId, costUsd: 0, costSource: "provider", latencyMs: Date.now() - started, error: reason };
    }

    const urls = [...(status.images ?? []).map((i) => i.url), status.video?.url, status.audio?.url, ...(status.audios ?? []).map((a) => a.url)].filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
    if (!urls.length) return { provider: "higgsfield", model: option.model, status: "failed", files: [], externalTaskId: requestId, costUsd, costSource, latencyMs: Date.now() - started, error: "completed without output URLs" };
    try {
      const files = await downloadMedia(urls, {
        prefix: `higgsfield-${option.model}-${requestId}`,
        maxBytes: option.capability.startsWith("video.") ? 300 * 1024 * 1024 : 50 * 1024 * 1024,
        fetch: this.opts.fetch,
        lookup: this.opts.lookup,
        signal,
      });
      return { provider: "higgsfield", model: option.model, status: "succeeded", files, externalTaskId: requestId, costUsd, costSource, latencyMs: Date.now() - started };
    } catch (err) {
      return { provider: "higgsfield", model: option.model, status: "failed", files: [], externalTaskId: requestId, costUsd, costSource, latencyMs: Date.now() - started, error: `result download failed: ${err instanceof Error ? err.message : "unknown"}` };
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const creds = await this.creds(this.opts.tenantId ?? null);
    if (!creds) return { status: "needs_configuration", detail: "Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (console.higgsfield.ai) to enable Higgsfield.", checkedAt };
    const started = Date.now();
    try {
      // Zero-cost: the estimate endpoint authenticates without generating anything.
      const est = await this.estimate(HEALTH_ENDPOINT, { prompt: "x" }, creds);
      return {
        status: "connected",
        detail: "Higgsfield credentials valid (checked via the free estimate endpoint).",
        latencyMs: Date.now() - started,
        checkedAt,
        meta: { estimateEndpoint: HEALTH_ENDPOINT, sampleEstimateUsd: est.usd, sampleEstimateCredits: est.credits ?? null, keySource: credentialSource("HIGGSFIELD_API_KEY", creds.key) },
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (err instanceof ProviderError && err.code === "auth") return { status: "error", detail: "Higgsfield rejected the credentials (HTTP 401).", latencyMs, checkedAt };
      if (err instanceof ProviderError && err.code === "insufficient_credits") return { status: "degraded", detail: "Higgsfield credentials valid but the account has insufficient credits.", latencyMs, checkedAt };
      return { status: "unavailable", detail: err instanceof Error ? err.message : "Higgsfield health check failed", latencyMs, checkedAt };
    }
  }
}
