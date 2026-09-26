import { describe, expect, it } from "vitest";
import { checkInboundTimestamp, inboundSignatureHash, inboundSignedPayload, parseBudget, parseInboundNotification, signInboundBody, verifyInboundSignature } from "./inbound";
import { parseFeed } from "./rss";

describe("verifyInboundSignature (timestamped, tenant-bound)", () => {
  const secret = "gpwh_test_secret_0123456789abcdef"; // gitleaks:allow — fake fixture, not a credential
  const body = JSON.stringify({ subject: "New brief", text: "hello" });
  const now = 1_790_000_000_000; // ms
  const ts = String(now / 1000);
  const base = { tenantSlug: "acme-1a2b3c", provider: "contra", body, timestamp: ts };
  const sign = (over: Partial<typeof base> = {}, s = secret) => signInboundBody({ ...base, ...over }, s);

  it("signs `${timestamp}.${tenantSlug}.${provider}.${rawBody}` as hex HMAC-SHA256", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", secret).update(`${ts}.acme-1a2b3c.contra.${body}`).digest("hex");
    expect(sign()).toBe(expected);
    expect(inboundSignedPayload(base).toString("utf8")).toBe(`${ts}.acme-1a2b3c.contra.${body}`);
  });

  it("accepts a valid signature (bare hex, sha256= prefix, upper case, bytes body) and returns sha256(signature)", () => {
    const sig = sign();
    const ok = verifyInboundSignature({ ...base, signature: sig, secret, nowMs: now });
    expect(ok).toEqual({ ok: true, signatureHash: inboundSignatureHash(sig) });
    expect(verifyInboundSignature({ ...base, signature: `sha256=${sig}`, secret, nowMs: now }).ok).toBe(true);
    expect(verifyInboundSignature({ ...base, signature: sig.toUpperCase(), secret, nowMs: now }).ok).toBe(true);
    expect(verifyInboundSignature({ ...base, body: new TextEncoder().encode(body), signature: sig, secret, nowMs: now }).ok).toBe(true);
    expect(inboundSignatureHash(sig)).toMatch(/^[0-9a-f]{64}$/);
    expect(inboundSignatureHash(sig)).not.toContain(sig);
  });

  it("binds the signature to the tenant, provider, timestamp and body", () => {
    const sig = sign();
    const v = (over: Record<string, unknown>) => verifyInboundSignature({ ...base, signature: sig, secret, nowMs: now, ...over });
    expect(v({ body: body + " " })).toEqual({ ok: false, reason: "mismatch" });
    expect(v({ tenantSlug: "other-tenant" })).toEqual({ ok: false, reason: "mismatch" });
    expect(v({ provider: "fiverr" })).toEqual({ ok: false, reason: "mismatch" });
    expect(v({ timestamp: String(Number(ts) + 1) })).toEqual({ ok: false, reason: "mismatch" });
    expect(v({ secret: "another-secret" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects clock skew beyond ±300 s", () => {
    const old = String(Number(ts) - 301);
    const future = String(Number(ts) + 301);
    expect(verifyInboundSignature({ ...base, timestamp: old, signature: sign({ timestamp: old }), secret, nowMs: now })).toEqual({ ok: false, reason: "skew" });
    expect(verifyInboundSignature({ ...base, timestamp: future, signature: sign({ timestamp: future }), secret, nowMs: now })).toEqual({ ok: false, reason: "skew" });
    const edge = String(Number(ts) - 300);
    expect(verifyInboundSignature({ ...base, timestamp: edge, signature: sign({ timestamp: edge }), secret, nowMs: now }).ok).toBe(true);
    expect(checkInboundTimestamp(ts, now)).toBeNull();
    expect(checkInboundTimestamp(old, now)).toEqual({ ok: false, reason: "skew" });
  });

  it("rejects missing/malformed headers and a missing secret", () => {
    const sig = sign();
    const v = (over: Record<string, unknown>) => verifyInboundSignature({ ...base, signature: sig, secret, nowMs: now, ...over });
    expect(v({ timestamp: null })).toEqual({ ok: false, reason: "missing" });
    expect(v({ timestamp: "12.5" })).toEqual({ ok: false, reason: "malformed" });
    expect(v({ timestamp: "-100" })).toEqual({ ok: false, reason: "malformed" });
    expect(v({ timestamp: `${ts}ms` })).toEqual({ ok: false, reason: "malformed" });
    expect(v({ signature: null })).toEqual({ ok: false, reason: "missing" });
    expect(v({ signature: "sha256=zz" })).toEqual({ ok: false, reason: "malformed" });
    expect(v({ secret: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(v({ secret: "" })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("parseBudget", () => {
  it.each([
    ["Budget: $500", { type: "fixed", min: 500, max: 500, currency: "USD" }],
    ["$1,200 - $2,500", { type: "fixed", min: 1200, max: 2500, currency: "USD" }],
    ["Hourly: $20.00-$40.00", { type: "hourly", min: 20, max: 40, currency: "USD" }],
    ["$30 - $50 per hour", { type: "hourly", min: 30, max: 50, currency: "USD" }],
    ["USD 2k", { type: "fixed", min: 2000, max: 2000, currency: "USD" }],
    ["€300 fixed", { type: "fixed", min: 300, max: 300, currency: "EUR" }],
  ])("%s", (text, expected) => expect(parseBudget(text)).toMatchObject(expected));
  it("returns unknown when no amount", () => expect(parseBudget("Budget: negotiable").type).toBe("unknown"));
});

describe("parseInboundNotification", () => {
  it("parses a forwarded Upwork job alert (HTML)", () => {
    const html = `<html><head><style>.x{}</style></head><body>
      <p>---------- Forwarded message ---------</p>
      <h2>Build a Shopify product configurator</h2>
      <p>Fixed-price: <b>$1,500</b></p>
      <p>We need a React-based product configurator for our Shopify store &amp; checkout integration.</p>
      <p>Skills: React, Shopify, Liquid</p>
      <a href="https://www.upwork.com/jobs/Build-Shopify-configurator_~01abcdef1234567890?utm_source=email">View job</a>
      <a href="https://www.upwork.com/ab/notification-settings">Unsubscribe</a>
      <script>steal()</script></body></html>`;
    const opp = parseInboundNotification({ provider: "upwork", subject: "Fwd: New job: Build a Shopify product configurator", html, from: "Upwork <donotreply@upwork.com>" });
    expect(opp).not.toBeNull();
    expect(opp!.sourceKey).toBe("upwork");
    expect(opp!.title).toBe("Build a Shopify product configurator");
    expect(opp!.url).toBe("https://www.upwork.com/jobs/Build-Shopify-configurator_~01abcdef1234567890");
    expect(opp!.externalId).toBe("~01abcdef1234567890");
    expect(opp!.budgetType).toBe("fixed");
    expect(opp!.budgetMinUsd).toBe(1500);
    expect(opp!.skills).toEqual(["React", "Shopify", "Liquid"]);
    expect(opp!.description).not.toMatch(/<|steal|Forwarded message/);
    expect(opp!.raw).toMatchObject({ ingestion: "email", from: "donotreply@upwork.com" });
  });

  it("parses a Contra opportunity email (text) with an hourly range", () => {
    const text = [
      "Hi Nick,",
      "A new opportunity matches your profile.",
      "Title: Motion designer for SaaS launch video",
      "Budget: $60-$90/hr",
      "We are launching in October and need a 60s explainer with UI animations.",
      "https://contra.com/opportunity/abc123-motion-designer",
      "Unsubscribe from these emails",
      "https://contra.com/settings/notifications",
    ].join("\n");
    const opp = parseInboundNotification({ provider: "contra", subject: "[Contra] New opportunity", text });
    expect(opp).toMatchObject({ sourceKey: "contra", title: "Motion designer for SaaS launch video", budgetType: "hourly", budgetMinUsd: 60, budgetMaxUsd: 90, url: "https://contra.com/opportunity/abc123-motion-designer" });
    expect(opp!.description).not.toContain("Unsubscribe");
  });

  it("parses a Fiverr brief and keeps non-USD budgets out of USD fields", () => {
    const opp = parseInboundNotification({ provider: "fiverr", subject: "New Brief: Logo animation for podcast", text: "Budget: €250\nNeed a 5s animated logo sting for our podcast intro, 1080p.\nhttps://www.fiverr.com/briefs/xyz789" });
    expect(opp).toMatchObject({ sourceKey: "fiverr", title: "Logo animation for podcast", currency: "EUR" });
    expect(opp!.budgetMinUsd).toBeUndefined();
    expect(opp!.raw).toMatchObject({ budgetOriginal: { min: 250, currency: "EUR" } });
  });

  it("returns null for non-opportunity mail and empty content", () => {
    expect(parseInboundNotification({ provider: "upwork", subject: "Your password was changed", text: "If this wasn't you..." })).toBeNull();
    expect(parseInboundNotification({ provider: "generic", subject: "", text: "hi" })).toBeNull();
  });

  it("generic provider maps to the direct source with a stable id", () => {
    const n = { provider: "generic" as const, subject: "Lead: need 10 AI product shots", text: "Client wants 10 AI product shots for a candle brand. Budget $400." };
    const a = parseInboundNotification(n);
    const b = parseInboundNotification(n);
    expect(a!.sourceKey).toBe("direct");
    expect(a!.externalId).toBe(b!.externalId);
  });
});

describe("parseFeed", () => {
  it("parses RSS items with CDATA and entities", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>x</title>
      <item>
        <title><![CDATA[Acme: Senior <Automation> Engineer & Co]]></title>
        <link>https://weworkremotely.com/remote-jobs/acme-automation</link>
        <guid>https://weworkremotely.com/remote-jobs/acme-automation</guid>
        <pubDate>Fri, 25 Sep 2026 07:31:05 +0000</pubDate>
        <type>Contract</type><region>Anywhere</region>
        <category>Programming</category>
        <description>&lt;p&gt;Build &amp;amp; ship &lt;b&gt;n8n&lt;/b&gt; flows&lt;/p&gt;</description>
      </item>
      <item><title>Beta &amp; Gamma: Designer</title><link>https://example.com/2</link><description><![CDATA[<p>Raw <i>html</i> ]]]]><![CDATA[> here</p>]]></description></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Acme: Senior <Automation> Engineer & Co", link: "https://weworkremotely.com/remote-jobs/acme-automation", categories: ["Programming"], fields: { type: "Contract", region: "Anywhere" } });
    expect(items[0]!.published).toBe("2026-09-25T07:31:05.000Z");
    expect(items[0]!.description).toBe("<p>Build &amp; ship <b>n8n</b> flows</p>");
    expect(items[1]!.title).toBe("Beta & Gamma: Designer");
    expect(items[1]!.description).toBe("<p>Raw <i>html</i> ]]> here</p>");
  });

  it("parses Atom entries", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Gig &lt;one&gt;</title><link rel="alternate" href="https://ex.com/1?a=1&amp;b=2"/><id>urn:1</id><updated>2026-09-01T10:00:00Z</updated><summary>Short</summary><category term="freelance"/></entry></feed>`;
    const [e] = parseFeed(xml);
    expect(e).toMatchObject({ title: "Gig <one>", link: "https://ex.com/1?a=1&b=2", guid: "urn:1", description: "Short", categories: ["freelance"] });
  });
});
