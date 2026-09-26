import type { RawOpportunity } from "@gigpilot/contracts";
import {
  INBOUND_SIGNATURE_HEADER,
  INBOUND_TIMESTAMP_HEADER,
  checkInboundTimestamp,
  parseInboundNotification,
  verifyInboundSignature,
  type InboundProvider,
} from "@gigpilot/providers";

/**
 * Core of POST /api/inbound/[provider] with its I/O injected (unit tested in
 * inbound-webhook.test.ts; the route wires the real database/commands).
 *
 * Scheme (security review M3):
 *   POST /api/inbound/<contra|fiverr|upwork|generic>?tenant=<slug>
 *   x-gigpilot-timestamp: <unix seconds>            (±300 s)
 *   x-gigpilot-signature: hex(HMAC-SHA256(secret, `${timestamp}.${slug}.${provider}.${rawBody}`))
 * Unknown tenant, missing secret, bad/missing signature and stale timestamps
 * all return the identical 401. sha256(signature) is claimed once (replay
 * protection). Rate limits key on tenant + provider — never a client IP.
 */

export const INBOUND_PROVIDERS: InboundProvider[] = ["contra", "fiverr", "upwork", "generic"];
export const INBOUND_MAX_BYTES = 1_000_000;
const SLUG = /^[a-z0-9-]{1,80}$/;
/** Used when the tenant/secret is unknown so every rejection costs the same HMAC. */
const DUMMY_SECRET = "gigpilot-inbound-dummy-secret-never-valid";

/** Passed to `ingestInboundOpportunity` (subject/sender already live in the parsed opportunity's raw). */
export interface InboundMeta {
  /** Relay-supplied message id (dedupes re-forwards of the same email). */
  messageId?: string;
}

export interface InboundDeps {
  rateLimit: (key: string, limit: number, windowMs: number) => { ok: boolean; retryAfterMs: number };
  /** Tenant id + its decrypted inbound secret for a slug, or null (unknown tenant / no secret). */
  loadTenantSecret: (slug: string) => Promise<{ tenantId: string; secret: string } | null>;
  /** Atomically claim a replay key; false when it was already claimed. */
  claimReplay: (key: string, tenantId: string, provider: InboundProvider) => Promise<boolean>;
  releaseReplay: (key: string) => Promise<void>;
  /** null → no row (treated as enabled). */
  sourceEnabled: (tenantId: string, sourceKey: string) => Promise<boolean | null>;
  ingest: (tenantId: string, raw: RawOpportunity, provider: InboundProvider, meta: InboundMeta) => Promise<{ opportunityId?: string | null; duplicate?: boolean } | void>;
  /** Classify ingest errors: conflict → duplicate (200), invalid → 422, anything else → 500. */
  classifyError: (err: unknown) => { kind: "conflict" | "invalid" | "other"; message?: string };
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

function json(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Identical for every authentication failure (no slug enumeration). */
export function inboundUnauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export async function handleInbound(request: Request, providerParam: string, deps: InboundDeps): Promise<Response> {
  if (!(INBOUND_PROVIDERS as string[]).includes(providerParam)) return json({ error: "unknown provider" }, 404);
  const provider = providerParam as InboundProvider;
  const nowMs = deps.now?.() ?? Date.now();

  const slug = (new URL(request.url).searchParams.get("tenant") ?? "").trim().toLowerCase().slice(0, 80);
  // Pre-auth work bound: global + per target (tenant slug × provider).
  const pre = deps.rateLimit("inbound:pre:all", 600, 60_000);
  const target = deps.rateLimit(`inbound:pre:${slug}:${provider}`, 120, 60_000);
  if (!pre.ok || !target.ok) return json({ error: "rate limited" }, 429, { "Retry-After": String(Math.ceil(Math.max(pre.retryAfterMs, target.retryAfterMs) / 1000)) });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > INBOUND_MAX_BYTES) return json({ error: "payload too large" }, 413);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > INBOUND_MAX_BYTES) return json({ error: "payload too large" }, 413);

  const timestamp = request.headers.get(INBOUND_TIMESTAMP_HEADER);
  const signature = request.headers.get(INBOUND_SIGNATURE_HEADER);
  if (checkInboundTimestamp(timestamp, nowMs)) return inboundUnauthorized();

  const found = SLUG.test(slug) ? await deps.loadTenantSecret(slug) : null;
  const verified = verifyInboundSignature({ body: raw, timestamp, signature, tenantSlug: slug, provider, secret: found?.secret ?? DUMMY_SECRET, nowMs });
  if (!found || !verified.ok) return inboundUnauthorized();
  const tenantId = found.tenantId;

  const rl = deps.rateLimit(`inbound:${tenantId}:${provider}`, 30, 60_000);
  if (!rl.ok) return json({ error: "rate limited" }, 429, { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const replayKey = `inbound:${tenantId}:${verified.signatureHash}`;
  if (!(await deps.claimReplay(replayKey, tenantId, provider))) return json({ error: "replayed request" }, 409);

  const text = new TextDecoder().decode(raw);
  let payload: { subject?: unknown; text?: unknown; html?: unknown; from?: unknown; receivedAt?: unknown; messageId?: unknown } = {};
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as typeof payload;
    } catch {
      await deps.releaseReplay(replayKey);
      return json({ error: "invalid JSON" }, 400);
    }
  } else {
    payload = { text };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  const sourceKey = provider === "generic" ? "direct" : provider;
  if ((await deps.sourceEnabled(tenantId, sourceKey)) === false) return json({ ignored: true, reason: "source disabled in Integrations" }, 202);

  const messageId = str(payload.messageId)?.trim().slice(0, 300) || undefined;
  const opportunity = parseInboundNotification({ provider, subject: str(payload.subject), text: str(payload.text), html: str(payload.html), from: str(payload.from), receivedAt: str(payload.receivedAt) });
  if (!opportunity) return json({ ignored: true, reason: "not an opportunity" }, 202);

  try {
    const res = await deps.ingest(tenantId, opportunity, provider, messageId ? { messageId } : {});
    if (res && res.duplicate) return json({ ok: true, duplicate: true }, 200);
    return json({ ok: true, opportunityId: (res && res.opportunityId) ?? null }, 201);
  } catch (err) {
    const c = deps.classifyError(err);
    if (c.kind === "conflict") return json({ ok: true, duplicate: true }, 200);
    await deps.releaseReplay(replayKey); // let the relay retry with the same signature after a failure
    if (c.kind === "invalid") return json({ error: c.message ?? "invalid opportunity" }, 422);
    deps.log?.({ level: "error", msg: "inbound intake failed", provider, error: err instanceof Error ? err.name : "error" });
    return json({ error: "intake failed" }, 500);
  }
}
