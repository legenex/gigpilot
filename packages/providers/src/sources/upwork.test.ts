import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTenantSecretLookup } from "../lib/credentials";
import { CLEAR_PROVIDER_ENV, jsonResponse, mockFetch, setEnv } from "../lib/testing";
import { UpworkSource, mapUpworkJob } from "./upwork";

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV });
});
afterEach(() => {
  restore();
  setTenantSecretLookup(null);
});

const node = {
  id: "1790000000000000001",
  ciphertext: "~01abcdef0123456789",
  title: "n8n automation for lead routing",
  description: "<p>Build an <b>n8n</b> workflow</p>",
  amount: { rawValue: "0", currency: "USD" },
  hourlyBudgetType: "HOURLY",
  hourlyBudgetMin: { rawValue: "35", currency: "USD" },
  hourlyBudgetMax: { rawValue: "60", currency: "USD" },
  skills: [{ name: "n8n", prettyName: "n8n" }, { name: "api-integration", prettyName: "API Integration" }],
  totalApplicants: 12,
  publishedDateTime: "2026-09-25T10:00:00Z",
  client: { totalSpent: { rawValue: "25400.5", currency: "USD" }, totalFeedback: 4.9, location: { country: "United States" }, totalHires: 31 },
};

describe("UpworkSource", () => {
  it("declares compliant capabilities: on-demand only, no background polling, 24h cache, no submission", () => {
    const c = new UpworkSource().capabilities;
    expect(c).toMatchObject({ canSearch: true, canSubmit: false, backgroundPollingAllowed: false, maxCacheTtlHours: 24, requiresUserOAuth: true, submitRequiresHumanConfirm: true, ingestionMode: "api" });
    expect(c.compliance).toMatch(/never polls|on-demand/i);
    expect("submit" in new UpworkSource()).toBe(false);
  });

  it("maps GraphQL job nodes (hourly, fixed) to RawOpportunity with a 24h cache expiry", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const hourly = mapUpworkJob(node, now)!;
    expect(hourly).toMatchObject({
      sourceKey: "upwork",
      externalId: "~01abcdef0123456789",
      url: "https://www.upwork.com/jobs/~01abcdef0123456789",
      budgetType: "hourly",
      budgetMinUsd: 35,
      budgetMaxUsd: 60,
      clientSpendUsd: 25400.5,
      clientCountry: "United States",
      clientRating: 4.9,
      proposalsCount: 12,
      skills: ["n8n", "API Integration"],
      postedAt: "2026-09-25T10:00:00Z",
    });
    expect(hourly.description).toBe("Build an n8n workflow");
    expect(hourly.raw?.cacheExpiresAt).toBe("2026-09-27T00:00:00.000Z");
    const fixed = mapUpworkJob({ ...node, hourlyBudgetType: null, hourlyBudgetMin: null, hourlyBudgetMax: null, amount: { rawValue: "750", currency: "USD" } }, now)!;
    expect(fixed).toMatchObject({ budgetType: "fixed", budgetMinUsd: 750, budgetMaxUsd: 750 });
    expect(mapUpworkJob({ title: "no id" })).toBeNull();
  });

  it("refuses background-style calls without a user query and requires a token", async () => {
    const f = mockFetch(() => jsonResponse({}));
    await expect(new UpworkSource({ fetch: f }).fetchOpportunities({ tenantId: "t1" })).rejects.toMatchObject({ code: "compliance" });
    setTenantSecretLookup(async () => undefined);
    await expect(new UpworkSource({ fetch: f }).fetchOpportunities({ tenantId: "t1", query: "n8n" })).rejects.toMatchObject({ code: "not_configured" });
    expect(f.calls).toHaveLength(0);
  });

  it("searches with the tenant's OAuth token via marketplaceJobPostingsSearch", async () => {
    setTenantSecretLookup(async (_t, provider, name) => (provider === "upwork" && name === "UPWORK_ACCESS_TOKEN" ? "oauth-user-token" : undefined));
    const f = mockFetch(() => jsonResponse({ data: { marketplaceJobPostingsSearch: { edges: [{ node }, { node: { title: "bad" } }] } } }));
    const res = await new UpworkSource({ fetch: f }).fetchOpportunities({ tenantId: "t1", query: "n8n automation", limit: 5 });
    expect(res).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.upwork.com/graphql");
    expect(call.headers.get("authorization")).toBe("Bearer oauth-user-token");
    const body = JSON.parse(call.body!);
    expect(body.query).toContain("marketplaceJobPostingsSearch");
    expect(body.variables).toMatchObject({ filter: { searchExpression_eq: "n8n automation", pagination_eq: { first: 5 } }, searchType: "USER_JOBS_SEARCH" });
  });

  it("maps auth and GraphQL errors without leaking the token", async () => {
    setTenantSecretLookup(async () => "oauth-user-token");
    const e401 = await new UpworkSource({ fetch: mockFetch(() => new Response("expired", { status: 401 })) }).fetchOpportunities({ tenantId: "t", query: "x" }).catch((e) => e);
    expect(e401.code).toBe("auth");
    const gql = await new UpworkSource({ fetch: mockFetch(() => jsonResponse({ errors: [{ message: "Insufficient scope for token oauth-user-token" }] })) }).fetchOpportunities({ tenantId: "t", query: "x" }).catch((e) => e);
    expect(gql.code).toBe("auth");
    expect(gql.message).not.toContain("oauth-user-token");
  });

  it("health: needs_configuration without token; minimal authorized query with one", async () => {
    expect((await new UpworkSource().health()).status).toBe("needs_configuration");
    const r = setEnv({ UPWORK_CLIENT_ID: "cid", UPWORK_CLIENT_SECRET: "cs" });
    expect(new UpworkSource().isConfigured()).toBe(true);
    const h = await new UpworkSource().health();
    expect(h.status).toBe("needs_configuration");
    expect(h.detail).toMatch(/OAuth/);
    r();
    setTenantSecretLookup(async (_t, _p, name) => (name === "UPWORK_ACCESS_TOKEN" ? "tok" : undefined));
    const f = mockFetch(() => jsonResponse({ data: { user: { id: "u1" } } }));
    const ok = await new UpworkSource({ fetch: f }).withTenant("t1").health();
    expect(ok.status).toBe("connected");
    expect(JSON.parse(f.calls[0]!.body!).query).toContain("user { id }");
  });
});
