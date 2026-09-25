import { describe, expect, it } from "vitest";
import { dedupeHash, findDuplicate, isExpired, matchServiceFamily, similarity, triageBudget } from "./rules";

describe("duplicate detection", () => {
  it("produces identical hashes for cosmetic differences", () => {
    const a = dedupeHash("Need 10 UGC videos for skincare brand!", "We are looking for creators to make TikTok ads. Budget $800.");
    const b = dedupeHash("need 10 ugc videos for skincare brand", "We are looking for creators to make TikTok ads.   Budget $800");
    expect(a).toBe(b);
  });

  it("detects near-duplicates cross-posted on different sources", () => {
    const existing = [
      {
        id: "opp-1",
        title: "Build an n8n automation that syncs Shopify orders to HubSpot",
        description:
          "We need an automation expert to build an n8n workflow syncing Shopify orders into HubSpot deals, with error alerts to Slack and a daily summary email.",
        dedupeHash: "x",
      },
    ];
    const dup = findDuplicate(
      {
        title: "n8n automation: sync Shopify orders to HubSpot",
        description:
          "Looking for an automation expert to build an n8n workflow syncing Shopify orders into HubSpot deals, with error alerts to Slack and a daily summary email!",
      },
      existing,
    );
    expect(dup).toBe("opp-1");
  });

  it("does not flag unrelated opportunities", () => {
    const existing = [{ id: "opp-1", title: "Logo design for bakery", description: "Need a warm, hand-drawn logo for a neighbourhood bakery.", dedupeHash: "x" }];
    expect(findDuplicate({ title: "Next.js SaaS dashboard", description: "Build a Next.js analytics dashboard with Stripe billing." }, existing)).toBeNull();
    expect(similarity("alpha beta gamma delta", "epsilon zeta eta theta")).toBe(0);
  });
});

describe("service matching", () => {
  const markets = [
    { key: "paid-social-ugc", enabled: true, keywords: ["ugc", "tiktok", "ad creative"] },
    { key: "ai-automation", enabled: true, keywords: ["automation", "n8n", "ai agent"] },
    { key: "web-app-builds", enabled: false, keywords: ["next.js", "website"] },
  ];

  it("matches the best enabled market", () => {
    expect(matchServiceFamily("Need TikTok UGC ad creative for supplements", [], markets)?.key).toBe("paid-social-ugc");
    expect(matchServiceFamily("Build an AI agent with n8n", ["automation"], markets)?.key).toBe("ai-automation");
  });

  it("ignores disabled markets and returns null for no match", () => {
    expect(matchServiceFamily("Build a Next.js website", [], markets)).toBeNull();
    expect(matchServiceFamily("Plumbing repair", [], markets)).toBeNull();
  });
});

describe("expiry and budget triage", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  it("expires by explicit expiry, deadline or age", () => {
    expect(isExpired({ expiresAt: new Date("2026-09-26T11:00:00Z") }, 96, now)).toBe(true);
    expect(isExpired({ deadlineAt: new Date("2026-09-25T00:00:00Z") }, 96, now)).toBe(true);
    expect(isExpired({ postedAt: new Date("2026-09-20T00:00:00Z") }, 96, now)).toBe(true);
    expect(isExpired({ postedAt: new Date("2026-09-25T00:00:00Z") }, 96, now)).toBe(false);
  });

  it("flags low and unknown budgets", () => {
    expect(triageBudget({ budgetType: "fixed", budgetMaxUsd: 150 }, 300)).toBe("low_budget");
    expect(triageBudget({ budgetType: "fixed", budgetMaxUsd: 900 }, 300)).toBe("ok");
    expect(triageBudget({ budgetType: "unknown" }, 300)).toBe("unknown_budget");
    expect(triageBudget({ budgetType: "hourly", budgetMaxUsd: 15 }, 300)).toBe("low_budget");
  });
});
