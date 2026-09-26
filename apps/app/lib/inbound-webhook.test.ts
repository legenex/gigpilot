import { beforeEach, describe, expect, it } from "vitest";
import { signInboundBody } from "@gigpilot/providers";
import { handleInbound, type InboundDeps } from "./inbound-webhook";

const NOW = 1_790_000_000_000;
const TS = String(NOW / 1000);
const SECRET = "gpwh_" + "ab".repeat(32);
const SLUG = "acme-1a2b3c";
const TENANT = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ subject: "New opportunity: 30s product video", text: "Budget: $800\nWe need a 30 second product video for our launch next month.", from: "Contra <no-reply@contra.com>" });

interface Harness {
  deps: InboundDeps;
  claimed: Set<string>;
  ingested: { tenantId: string; provider: string; title: string }[];
  rateKeys: string[];
}

function harness(over: Partial<InboundDeps> = {}): Harness {
  const claimed = new Set<string>();
  const ingested: Harness["ingested"] = [];
  const rateKeys: string[] = [];
  const deps: InboundDeps = {
    rateLimit: (key) => {
      rateKeys.push(key);
      return { ok: true, retryAfterMs: 0 };
    },
    loadTenantSecret: async (slug) => (slug === SLUG ? { tenantId: TENANT, secret: SECRET } : null),
    claimReplay: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    releaseReplay: async (key) => {
      claimed.delete(key);
    },
    sourceEnabled: async () => true,
    ingest: async (tenantId, raw, provider) => {
      ingested.push({ tenantId, provider, title: raw.title });
      return { opportunityId: "opp-1" };
    },
    classifyError: () => ({ kind: "other" }),
    now: () => NOW,
    ...over,
  };
  return { deps, claimed, ingested, rateKeys };
}

function req(opts: { provider?: string; slug?: string; body?: string; ts?: string | null; sig?: string | null; secret?: string; headers?: Record<string, string> } = {}) {
  const provider = opts.provider ?? "contra";
  const slug = opts.slug ?? SLUG;
  const body = opts.body ?? BODY;
  const ts = opts.ts === undefined ? TS : opts.ts;
  const sig = opts.sig === undefined ? signInboundBody({ timestamp: ts ?? "", tenantSlug: slug, provider, body }, opts.secret ?? SECRET) : opts.sig;
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (ts !== null) headers["x-gigpilot-timestamp"] = ts;
  if (sig !== null) headers["x-gigpilot-signature"] = sig;
  return { request: new Request(`http://app.local/api/inbound/${provider}?tenant=${slug}`, { method: "POST", headers, body }), provider };
}

async function call(h: Harness, r: ReturnType<typeof req>) {
  const res = await handleInbound(r.request, r.provider, h.deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("inbound webhook (M3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("accepts a correctly signed request and ingests it for the tenant", async () => {
    const r = await call(h, req());
    expect(r).toEqual({ status: 201, body: { ok: true, opportunityId: "opp-1" } });
    expect(h.ingested).toEqual([{ tenantId: TENANT, provider: "contra", title: expect.stringContaining("30s product video") }]);
  });

  it("returns the SAME 401 for unknown tenant, bad signature, missing headers and stale timestamps", async () => {
    const unknown = await call(h, req({ slug: "no-such-tenant" }));
    const badSig = await call(h, req({ secret: "gpwh_wrong" }));
    const noSig = await call(h, req({ sig: null }));
    const noTs = await call(h, req({ ts: null }));
    const stale = await call(h, req({ ts: String(NOW / 1000 - 301) }));
    const future = await call(h, req({ ts: String(NOW / 1000 + 301) }));
    const otherProvider = await call(h, { request: req({ provider: "fiverr" }).request, provider: "contra" });
    const badSlug = await call(h, req({ slug: "../etc" }));
    for (const r of [unknown, badSig, noSig, noTs, stale, future, otherProvider, badSlug]) expect(r).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(h.ingested).toHaveLength(0);
  });

  it("treats a tenant without an inbound secret exactly like an unknown tenant (no env fallback)", async () => {
    const noSecret = harness({ loadTenantSecret: async () => null });
    expect(await call(noSecret, req())).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("refuses replays of an accepted signature", async () => {
    const r = req();
    const first = await call(h, r);
    const again = await call(h, req());
    expect(first.status).toBe(201);
    expect(again).toEqual({ status: 409, body: { error: "replayed request" } });
    expect(h.ingested).toHaveLength(1);
  });

  it("releases the replay claim when intake fails so the relay can retry", async () => {
    const failing = harness({
      ingest: async () => {
        throw new Error("db down");
      },
    });
    expect((await call(failing, req())).status).toBe(500);
    expect(failing.claimed.size).toBe(0);
  });

  it("keys rate limits on tenant + provider, never on client-supplied IP headers", async () => {
    await call(h, req({ headers: { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" } }));
    expect(h.rateKeys).toEqual(["inbound:pre:all", `inbound:pre:${SLUG}:contra`, `inbound:${TENANT}:contra`]);
    expect(h.rateKeys.join(" ")).not.toMatch(/6\.6\.6\.6|7\.7\.7\.7/);
    const limited = harness({ rateLimit: (key) => ({ ok: !key.startsWith(`inbound:${TENANT}`), retryAfterMs: 5000 }) });
    const r = await call(limited, req());
    expect(r.status).toBe(429);
    expect(limited.claimed.size).toBe(0);
  });

  it("rejects unknown providers, oversized bodies and invalid JSON", async () => {
    expect((await call(h, { request: req().request, provider: "linkedin" })).status).toBe(404);
    const big = "x".repeat(1_000_001);
    expect((await call(h, req({ body: big }))).status).toBe(413);
    const bad = await call(h, req({ body: "{not json" }));
    expect(bad.status).toBe(400);
    expect(h.claimed.size).toBe(0);
  });

  it("ignores disabled sources and non-opportunities without ingesting", async () => {
    const disabled = harness({ sourceEnabled: async () => false });
    expect((await call(disabled, req())).status).toBe(202);
    const notOpp = await call(h, req({ body: JSON.stringify({ subject: "Reset your password", text: "Click here to reset your password for your account." }) }));
    expect(notOpp).toEqual({ status: 202, body: { ignored: true, reason: "not an opportunity" } });
    expect(disabled.ingested).toHaveLength(0);
  });
});
