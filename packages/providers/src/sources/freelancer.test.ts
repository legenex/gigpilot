import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setOperatorTenantCheck, setTenantSecretLookup } from "../lib/credentials";
import { CLEAR_PROVIDER_ENV, jsonResponse, mockFetch, setEnv, type RecordedCall } from "../lib/testing";
import { FreelancerSource, describeFreelancerError, mapFreelancerProject, resetFreelancerRateState, toUsd } from "./freelancer";

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, FREELANCER_OAUTH_TOKEN: "fl-token-abc" });
  resetFreelancerRateState();
  // The env token is an operator credential: these tests act as an operator workspace.
  setTenantSecretLookup(async () => undefined);
  setOperatorTenantCheck(async () => true);
});
afterEach(() => {
  restore();
  setTenantSecretLookup(null);
  setOperatorTenantCheck(null);
});

const project = {
  id: 40123456,
  owner_id: 77,
  title: "Shopify store AI product photos",
  seo_url: "photography/shopify-store-product-photos",
  description: "Need 30 product images",
  type: "fixed",
  currency: { code: "INR", exchange_rate: 0.012, sign: "₹" },
  budget: { minimum: 12500, maximum: 37500 },
  bid_stats: { bid_count: 14, bid_avg: 20000 },
  time_submitted: 1790380000,
  jobs: [{ name: "Photography" }, { name: "Photoshop" }],
  frontend_project_status: "open",
};
const users = { "77": { id: 77, username: "acme", display_name: "Acme Co", location: { country: { name: "India" } }, employer_reputation: { entire_history: { overall: 4.7 } } } };

describe("Freelancer mapping", () => {
  it("converts budgets to USD with exchange_rate and maps fields", () => {
    expect(toUsd(12500, project.currency)).toBe(150);
    expect(toUsd(100, { code: "USD" })).toBe(100);
    expect(toUsd(100, { code: "EUR" })).toBeUndefined();
    const o = mapFreelancerProject(project, users)!;
    expect(o).toMatchObject({
      sourceKey: "freelancer",
      externalId: "40123456",
      url: "https://www.freelancer.com/projects/photography/shopify-store-product-photos",
      budgetType: "fixed",
      budgetMinUsd: 150,
      budgetMaxUsd: 450,
      currency: "INR",
      clientName: "Acme Co",
      clientCountry: "India",
      clientRating: 4.7,
      proposalsCount: 14,
      skills: ["Photography", "Photoshop"],
      postedAt: new Date(1790380000 * 1000).toISOString(),
    });
    expect(mapFreelancerProject(project, users, "https://www.freelancer-sandbox.com/api")!.url).toMatch(/^https:\/\/www\.freelancer-sandbox\.com\//);
  });

  it("describes documented error codes", () => {
    expect(describeFreelancerError("ProjectExceptionCodes.BID_DESCRIPTION_CONTAINS_EMAIL", "x")).toMatch(/email addresses/);
    expect(describeFreelancerError("BID_LIMIT_EXCEEDED", undefined)).toMatch(/used all available bids/);
    expect(describeFreelancerError("SOMETHING_NEW", "Raw message")).toBe("Raw message (SOMETHING_NEW)");
  });
});

describe("FreelancerSource", () => {
  it("declares capabilities: API search, human-confirmed submit, polling ≥ 30 min", () => {
    expect(new FreelancerSource().capabilities).toMatchObject({ canSearch: true, canSubmit: true, submitRequiresHumanConfirm: true, backgroundPollingAllowed: true, minPollIntervalMinutes: 30 });
  });

  it("searches active projects with the OAuth header and respects RateLimit-Remaining", async () => {
    const f = mockFetch(() => jsonResponse({ status: "success", result: { projects: [project], users } }, 200, { "RateLimit-Remaining": "0", "RateLimit-Reset": "120" }));
    const src = new FreelancerSource({ fetch: f });
    const res = await src.fetchOpportunities({ tenantId: "t1", query: "product photos", since: new Date(1790000000 * 1000) });
    expect(res).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/api/projects/0.1/projects/active/");
    expect(u.searchParams.get("query")).toBe("product photos");
    expect(u.searchParams.getAll("project_types[]")).toEqual(["fixed", "hourly"]);
    expect(u.searchParams.get("full_description")).toBe("true");
    expect(u.searchParams.get("from_time")).toBe("1790000000");
    expect(f.calls[0]!.headers.get("freelancer-oauth-v1")).toBe("fl-token-abc");
    await expect(src.fetchOpportunities({ tenantId: "t1" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(f.calls).toHaveLength(1);
  });

  function bidServer(opts: { existing?: boolean; post?: (c: RecordedCall) => Response } = {}) {
    return mockFetch((url, call) => {
      if (url.pathname === "/api/users/0.1/self/") return jsonResponse({ status: "success", result: { id: 555, username: "me" } });
      if (url.pathname === `/api/projects/0.1/projects/${project.id}/`) return jsonResponse({ status: "success", result: project });
      if (url.pathname === "/api/projects/0.1/bids/" && call.method === "GET") return jsonResponse({ status: "success", result: { bids: opts.existing ? [{ id: 999, bidder_id: 555, project_id: project.id }] : [{ id: 1, bidder_id: 42, project_id: project.id }] } });
      if (url.pathname === "/api/projects/0.1/bids/" && call.method === "POST") return opts.post ? opts.post(call) : jsonResponse({ status: "success", result: { id: 31337 } });
      return jsonResponse({ status: "error", message: "nf" }, 404);
    });
  }
  const sub = { externalOpportunityId: String(project.id), coverLetter: "Hi — I can deliver 30 clean product images in 5 days with two revision rounds included.", amountUsd: 300, periodDays: 5, idempotencyKey: "app-1" };

  it("places exactly one bid, converting USD into the project currency", async () => {
    const f = bidServer();
    const res = await new FreelancerSource({ fetch: f }).withTenant("t1").submit(sub);
    expect(res).toMatchObject({ status: "submitted", externalRef: "31337" });
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ project_id: project.id, bidder_id: 555, amount: 25000, period: 5, milestone_percentage: 100, description: sub.coverLetter });
    const bidsCheck = new URL(f.calls.find((c) => c.method === "GET" && c.url.includes("/bids/"))!.url);
    expect(bidsCheck.searchParams.getAll("projects[]")).toEqual([String(project.id)]);
  });

  it("refuses to bid twice on the same project", async () => {
    const f = bidServer({ existing: true });
    const res = await new FreelancerSource({ fetch: f }).submit(sub);
    expect(res).toMatchObject({ status: "rejected", externalRef: "999" });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("maps documented bid errors to clear rejections and never retries the POST", async () => {
    const f = bidServer({ post: () => jsonResponse({ status: "error", message: "Description has email", error_code: "ProjectExceptionCodes.BID_DESCRIPTION_CONTAINS_EMAIL", request_id: "r1" }, 400) });
    const res = await new FreelancerSource({ fetch: f }).submit(sub);
    expect(res.status).toBe("rejected");
    expect(res.detail).toMatch(/email addresses/);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const f5 = bidServer({ post: () => jsonResponse({ status: "error", message: "oops" }, 503) });
    await expect(new FreelancerSource({ fetch: f5 }).submit(sub)).rejects.toMatchObject({ code: "unavailable" });
    expect(f5.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("validates inputs and handles missing credentials", async () => {
    expect((await new FreelancerSource().submit({ ...sub, externalOpportunityId: "abc" })).status).toBe("rejected");
    const r = setEnv({ FREELANCER_OAUTH_TOKEN: undefined });
    expect(new FreelancerSource().isConfigured()).toBe(false);
    expect((await new FreelancerSource().submit(sub)).status).toBe("rejected");
    expect((await new FreelancerSource().health()).status).toBe("needs_configuration");
    await expect(new FreelancerSource().fetchOpportunities({ tenantId: "t" })).rejects.toMatchObject({ code: "not_configured" });
    r();
  });

  it("supports the sandbox base URL and rejects foreign hosts", async () => {
    const r = setEnv({ FREELANCER_BASE_URL: "https://www.freelancer-sandbox.com/api" });
    const f = mockFetch(() => jsonResponse({ status: "success", result: { id: 1, username: "sb" } }));
    const h = await new FreelancerSource({ fetch: f }).health();
    expect(h.status).toBe("connected");
    expect(f.calls[0]!.url).toBe("https://www.freelancer-sandbox.com/api/users/0.1/self/");
    r();
    const r2 = setEnv({ FREELANCER_BASE_URL: "https://evil.example.com/api" });
    await expect(new FreelancerSource({ fetch: f }).fetchOpportunities({ tenantId: "t" })).rejects.toMatchObject({ code: "validation" });
    r2();
  });
});
