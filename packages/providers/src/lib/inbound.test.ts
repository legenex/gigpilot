import { describe, expect, it } from "vitest";
import { parseBudget, parseInboundNotification, signInboundBody, verifyInboundSignature } from "./inbound";
import { parseFeed } from "./rss";

describe("verifyInboundSignature", () => {
  const secret = "whsec_test_123";
  const body = JSON.stringify({ subject: "New brief", text: "hello" });

  it("accepts valid signatures (bare hex or sha256= prefix)", () => {
    const sig = signInboundBody(body, secret);
    expect(verifyInboundSignature(body, sig, secret)).toBe(true);
    expect(verifyInboundSignature(body, sig.replace("sha256=", ""), secret)).toBe(true);
    expect(verifyInboundSignature(new TextEncoder().encode(body), sig.toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(true);
  });

  it("rejects tampering, wrong secrets, malformed headers and a missing secret", () => {
    const sig = signInboundBody(body, secret);
    expect(verifyInboundSignature(body + " ", sig, secret)).toBe(false);
    expect(verifyInboundSignature(body, sig, "other")).toBe(false);
    expect(verifyInboundSignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifyInboundSignature(body, null, secret)).toBe(false);
    expect(verifyInboundSignature(body, sig, undefined)).toBe(false);
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
