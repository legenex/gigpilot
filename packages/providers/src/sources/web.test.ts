import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeed } from "../lib/rss";
import { CLEAR_PROVIDER_ENV, jsonResponse, lookupTo, mockFetch, publicLookup, setEnv } from "../lib/testing";
import { ContraSource } from "./contra";
import { DirectSource, parseCsv, parseDirectProspectsCsv } from "./direct";
import { FiverrSource } from "./fiverr";
import { WebFeedSource, mapHnComment, mapRemoteOkJob, mapRemotiveJob, mapWwrItem, resetWebFeedCache } from "./web";

const WWR = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item><title>Acme Labs: Automation Engineer (n8n)</title><region>Anywhere in the World</region><country></country><skills>n8n, Zapier</skills><category>Programming</category><type>Contract</type>
<description>&lt;p&gt;Build &lt;b&gt;automation&lt;/b&gt; flows for clients.&lt;/p&gt;</description><pubDate>Fri, 25 Sep 2026 07:31:05 +0000</pubDate><guid>https://weworkremotely.com/remote-jobs/acme-automation</guid><link>https://weworkremotely.com/remote-jobs/acme-automation</link></item>
<item><title>BigCo: Account Executive</title><type>Full-Time</type><description><![CDATA[<p>Quota-carrying sales role.</p>]]></description><pubDate>Thu, 24 Sep 2026 07:31:05 +0000</pubDate><guid>https://weworkremotely.com/remote-jobs/bigco-ae</guid><link>https://weworkremotely.com/remote-jobs/bigco-ae</link></item>
</channel></rss>`;

const REMOTIVE = { "0-legal-notice": "…", jobs: [{ id: 2091144, url: "https://remotive.com/remote-jobs/dev/automation-contractor-1", title: "Automation contractor", company_name: "Flowly", tags: ["zapier", "automation"], job_type: "contract", publication_date: "2026-09-21T12:55:11", candidate_required_location: "Worldwide", salary: "$50 - $70 per hour", description: "<p>Contract automation work</p>" }, { id: 2, title: "Full-time support", job_type: "full_time", description: "x", publication_date: "2026-09-20T10:00:00" }] };
const REMOTEOK = [{ last_updated: "1790265606", legal: "API Terms of Service: link back…" }, { id: "1137431", slug: "remote-freelance-automation", url: "https://remoteOK.com/remote-jobs/remote-freelance-automation", position: "Freelance Automation Specialist", company: "Mercier", tags: ["freelance", "automation"], description: "<p>Automate things</p>", date: "2026-09-24T16:00:06+00:00", salary_min: "0" }];
const HN_STORIES = { hits: [{ objectID: "45438503", title: "Ask HN: Who is hiring? (October 2025)" }, { objectID: "45438502", title: "Ask HN: Freelancer? Seeking freelancer? (October 2025)" }] };
const HN_COMMENTS = {
  hits: [
    { objectID: "1", author: "hirer", comment_text: "SEEKING FREELANCER | Remote | n8n automation<p>Need help automating onboarding. Budget $2,000 fixed.", created_at: "2025-10-15T07:46:54Z", parent_id: 45438502, story_id: 45438502 },
    { objectID: "2", author: "dev", comment_text: "SEEKING WORK | Remote<p>I build automations", created_at: "2025-10-15T07:46:54Z", parent_id: 45438502, story_id: 45438502 },
    { objectID: "3", author: "reply", comment_text: "SEEKING FREELANCER reply", created_at: "2025-10-15T07:46:54Z", parent_id: 1, story_id: 45438502 },
  ],
};

function feedServer() {
  return mockFetch((url) => {
    if (url.hostname === "weworkremotely.com") return new Response(WWR, { status: 200, headers: { "content-type": "application/rss+xml" } });
    if (url.hostname === "remotive.com") return jsonResponse(REMOTIVE);
    if (url.hostname === "remoteok.com") return jsonResponse(REMOTEOK);
    if (url.hostname === "hn.algolia.com" && url.pathname.endsWith("search_by_date")) return jsonResponse(HN_STORIES);
    if (url.hostname === "hn.algolia.com") return jsonResponse(HN_COMMENTS);
    if (url.hostname === "jobs.example.org") return new Response(`<rss><channel><item><title>Contract: Video editor</title><link>https://jobs.example.org/1</link><description>freelance edit</description></item></channel></rss>`, { status: 200 });
    return new Response("nf", { status: 404 });
  });
}

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV });
  resetWebFeedCache();
});
afterEach(() => restore());

describe("feed mappers", () => {
  it("maps WWR items with attribution and contract detection", () => {
    const [a, b] = parseFeed(WWR).map(mapWwrItem);
    expect(a).toMatchObject({ sourceKey: "web", title: "Automation Engineer (n8n)", clientName: "Acme Labs", url: "https://weworkremotely.com/remote-jobs/acme-automation", skills: ["n8n", "Zapier"], description: "Build automation flows for clients." });
    expect(a!.raw).toMatchObject({ contract: true, attribution: { name: "We Work Remotely", linkRequired: true } });
    expect(b!.raw.contract).toBe(false);
  });

  it("maps Remotive, Remote OK (skips legal element) and HN (top-level SEEKING FREELANCER only)", () => {
    const r = mapRemotiveJob(REMOTIVE.jobs[0]!)!;
    expect(r).toMatchObject({ externalId: "remotive:2091144", budgetType: "hourly", budgetMinUsd: 50, budgetMaxUsd: 70, postedAt: "2026-09-21T12:55:11.000Z" });
    expect(r.raw).toMatchObject({ contract: true, attribution: { name: "Remotive" } });
    expect(mapRemoteOkJob(REMOTEOK[0] as never)).toBeNull();
    expect(mapRemoteOkJob(REMOTEOK[1] as never)!.raw).toMatchObject({ contract: true, attribution: { name: "Remote OK" } });
    const hn = HN_COMMENTS.hits.map((h) => mapHnComment(h, "45438502"));
    expect(hn[0]).toMatchObject({ externalId: "hn:1", title: "Remote | n8n automation", budgetType: "fixed", budgetMinUsd: 2000, url: "https://news.ycombinator.com/item?id=1" });
    expect(hn[1]).toBeNull();
    expect(hn[2]).toBeNull();
  });
});

describe("WebFeedSource", () => {
  it("declares capabilities with attribution and polling allowed", () => {
    expect(new WebFeedSource().capabilities).toMatchObject({ canSearch: true, canSubmit: false, backgroundPollingAllowed: true, attribution: { linkRequired: true } });
  });

  it("fetches configured feeds, filters to contract work + query, and sorts newest first", async () => {
    const f = feedServer();
    const src = new WebFeedSource({ fetch: f, configLoader: async () => ({ feeds: ["wwr", "remotive", "hn", "remoteok"], query: "automation" }) });
    const res = await src.fetchOpportunities({ tenantId: "t1" });
    expect(res.map((r) => r.externalId)).toEqual(["wwr:https://weworkremotely.com/remote-jobs/acme-automation", "remoteok:1137431", "remotive:2091144", "hn:1"]);
    expect(f.calls.every((c) => c.headers.get("user-agent")?.startsWith("GigPilot/"))).toBe(true);
  });

  it("enforces minimum intervals process-wide (one upstream request per feed per interval)", async () => {
    let now = Date.parse("2026-09-26T00:00:00Z");
    const f = feedServer();
    const mk = () => new WebFeedSource({ fetch: f, configLoader: async () => ({ feeds: ["remotive"] }), now: () => now });
    await mk().fetchOpportunities({ tenantId: "t1" });
    await mk().fetchOpportunities({ tenantId: "t2", query: "zapier" });
    now += 59 * 60_000;
    await mk().fetchOpportunities({ tenantId: "t1" });
    expect(f.calls.filter((c) => c.url.includes("remotive.com"))).toHaveLength(1);
    now += 302 * 60_000; // > 360 min since first fetch
    await mk().fetchOpportunities({ tenantId: "t1" });
    expect(f.calls.filter((c) => c.url.includes("remotive.com"))).toHaveLength(2);
  });

  it("returns partial results when one feed fails and throws when all fail", async () => {
    const f = mockFetch((url) => (url.hostname === "remoteok.com" ? jsonResponse(REMOTEOK) : new Response("down", { status: 503 })));
    const res = await new WebFeedSource({ fetch: f, configLoader: async () => ({ feeds: ["remoteok", "wwr"], contractOnly: false }) }).fetchOpportunities({ tenantId: "t" });
    expect(res).toHaveLength(1);
    resetWebFeedCache();
    const dead = mockFetch(() => new Response("down", { status: 503 }));
    await expect(new WebFeedSource({ fetch: dead, configLoader: async () => ({ feeds: ["wwr"] }) }).fetchOpportunities({ tenantId: "t" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fetches custom feeds through the SSRF guard", async () => {
    const f = feedServer();
    const ok = await new WebFeedSource({ fetch: f, lookup: publicLookup, configLoader: async () => ({ feeds: [], customFeeds: ["https://jobs.example.org/rss"] }) }).fetchOpportunities({ tenantId: "t" });
    expect(ok).toHaveLength(1);
    expect(ok[0]!.raw).toMatchObject({ feed: "custom", attribution: { name: "jobs.example.org" } });
    resetWebFeedCache();
    const blocked = new WebFeedSource({ fetch: f, lookup: lookupTo("10.0.0.8"), configLoader: async () => ({ feeds: [], customFeeds: ["https://jobs.example.org/rss", "http://127.0.0.1/rss", "http://169.254.169.254/latest"] }) });
    await expect(blocked.fetchOpportunities({ tenantId: "t" })).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls.filter((c) => c.url.includes("127.0.0.1") || c.url.includes("169.254") || c.url.includes("jobs.example.org"))).toHaveLength(1); // only the earlier allowed call
  });

  it("health makes no network calls", async () => {
    const h = await new WebFeedSource().health();
    expect(h.status).toBe("connected");
    expect(h.meta?.feeds).toHaveLength(4);
  });
});

describe("Contra / Fiverr / Direct", () => {
  it("inbound-only marketplaces never fetch and never submit", async () => {
    for (const s of [new ContraSource(), new FiverrSource()]) {
      expect(s.capabilities).toMatchObject({ canSearch: false, canSubmit: false, ingestionMode: "email", backgroundPollingAllowed: false });
      expect(s.capabilities.compliance).toMatch(/Terms prohibit/);
      expect(await s.fetchOpportunities({ tenantId: "t" })).toEqual([]);
      expect("submit" in s).toBe(false);
      expect((await s.health()).status).toBe("needs_configuration");
    }
    const r = setEnv({ INBOUND_WEBHOOK_SECRET: "sec" });
    expect((await new ContraSource().health()).status).toBe("connected");
    expect(new FiverrSource().isConfigured()).toBe(true);
    expect(new ContraSource().parse({ subject: "New opportunity: Brand video", text: "Budget: $800\nWe need a 30s brand video for launch." })).toMatchObject({ sourceKey: "contra", budgetMinUsd: 800 });
    r();
  });

  it("direct is always connected and parses prospect CSVs", async () => {
    const d = new DirectSource();
    expect(d.isConfigured()).toBe(true);
    expect((await d.health()).status).toBe("connected");
    expect(await d.fetchOpportunities({ tenantId: "t" })).toEqual([]);
    expect(parseCsv('a,"b ""q"", c",d\r\n1,2,3')).toEqual([["a", 'b "q", c', "d"], ["1", "2", "3"]]);
    const csv = "﻿Title,Company,Budget,Budget Type,Skills,URL,Deadline\n" + '"Website refresh","Acme, Inc.","$1,500",fixed,"Webflow; SEO",https://acme.example,2026-10-30\n' + ",NoTitle,100,,,,\n" + "Hourly SEO help,Beta,$40-$60/hr,,SEO,,";
    const { opportunities, skipped } = parseDirectProspectsCsv(csv);
    expect(skipped).toBe(1);
    expect(opportunities[0]).toMatchObject({ sourceKey: "direct", title: "Website refresh", clientName: "Acme, Inc.", budgetType: "fixed", budgetMinUsd: 1500, skills: ["Webflow", "SEO"], url: "https://acme.example", deadlineAt: "2026-10-30T00:00:00.000Z" });
    expect(opportunities[1]).toMatchObject({ budgetType: "hourly", budgetMinUsd: 40, budgetMaxUsd: 60 });
  });
});
