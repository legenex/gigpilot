import { describe, expect, it } from "vitest";
import { dedupeHash, findDuplicate, isExpired } from "@gigpilot/economics";
import { MOCK_BUCKET_MINUTES, MockSource } from "./mock";

const T = "3f6b8f1e-2c7a-4d1b-9a55-0e2f6f1c9a10";
const at = (iso: string) => () => new Date(iso);

describe("MockSource (demo marketplace)", () => {
  it("declares demo capabilities", () => {
    const s = new MockSource();
    expect(s.capabilities).toMatchObject({ canSearch: true, canSubmit: true, ingestionMode: "mock", backgroundPollingAllowed: true, minPollIntervalMinutes: 15 });
    expect(s.isConfigured()).toBe(true);
  });

  it("returns a deterministic 25–40 item batch spread over all six families", async () => {
    const a = await new MockSource({ now: at("2026-09-26T10:05:00Z") }).fetchOpportunities({ tenantId: T });
    const b = await new MockSource({ now: at("2026-09-26T10:20:00Z") }).fetchOpportunities({ tenantId: T });
    expect(a.length).toBeGreaterThanOrEqual(25);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(b.map((o) => o.externalId)).toEqual(a.map((o) => o.externalId)); // same 30-minute bucket
    const families = new Set(a.map((o) => (o.raw as { family?: string }).family).filter(Boolean));
    expect(families.size).toBe(6);
    const budgets = a.map((o) => o.budgetMaxUsd ?? 0);
    expect(Math.min(...budgets)).toBeLessThan(300); // some low-budget items
    expect(Math.max(...budgets)).toBeGreaterThanOrEqual(1500);
    expect(a.some((o) => o.budgetType === "hourly")).toBe(true);
    expect(a.every((o) => o.title.length > 10 && o.description.length > 60 && o.clientName)).toBe(true);
  });

  it("adds 3–8 new items per bucket with stable external ids", async () => {
    const t0 = Date.parse("2026-09-26T10:05:00Z");
    const first = await new MockSource({ now: () => new Date(t0) }).fetchOpportunities({ tenantId: T });
    const next = await new MockSource({ now: () => new Date(t0 + MOCK_BUCKET_MINUTES * 60_000) }).fetchOpportunities({ tenantId: T });
    const seen = new Set(first.map((o) => o.externalId));
    const fresh = next.filter((o) => !seen.has(o.externalId));
    expect(fresh.length).toBeGreaterThanOrEqual(3);
    expect(fresh.length).toBeLessThanOrEqual(8);
    const overlap = next.filter((o) => seen.has(o.externalId));
    for (const o of overlap) expect(first.find((f) => f.externalId === o.externalId)!.title).toBe(o.title);
  });

  it("includes near-duplicate cross-posts and items already expired on arrival across a day of buckets", async () => {
    const src = new MockSource({ now: at("2026-09-26T12:00:00Z") });
    const bucket0 = Math.floor(Date.parse("2026-09-26T12:00:00Z") / (MOCK_BUCKET_MINUTES * 60_000));
    const items = Array.from({ length: 48 }, (_, i) => src.bucketItems(T, bucket0 - i)).flat();
    const crossPosts = items.filter((o) => (o.raw as { crossPostOf?: string }).crossPostOf);
    expect(crossPosts.length).toBeGreaterThan(0);
    for (const c of crossPosts.slice(0, 3)) {
      const original = items.find((o) => o.externalId === (c.raw as { crossPostOf: string }).crossPostOf)!;
      expect(findDuplicate(c, [{ id: "orig", title: original.title, description: original.description, dedupeHash: dedupeHash(original.title, original.description) }])).toBe("orig");
    }
    const now = new Date("2026-09-26T12:00:00Z");
    const expired = items.filter((o) => isExpired({ postedAt: o.postedAt ? new Date(o.postedAt) : null, deadlineAt: o.deadlineAt ? new Date(o.deadlineAt) : null }, 96, now));
    expect(expired.length).toBeGreaterThan(0);
  });

  it("differs per tenant and simulates submission deterministically", async () => {
    const a = await new MockSource({ now: at("2026-09-26T10:05:00Z") }).fetchOpportunities({ tenantId: T });
    const b = await new MockSource({ now: at("2026-09-26T10:05:00Z") }).fetchOpportunities({ tenantId: "another-tenant-id-0000" });
    expect(a.map((o) => o.title).join("|")).not.toBe(b.map((o) => o.title).join("|"));
    const s = new MockSource();
    const r1 = await s.submit({ externalOpportunityId: "x", coverLetter: "hi", amountUsd: 100, periodDays: 5, idempotencyKey: "k1" });
    const r2 = await s.submit({ externalOpportunityId: "x", coverLetter: "hi", amountUsd: 100, periodDays: 5, idempotencyKey: "k1" });
    expect(r1.status).toBe("submitted");
    expect(r1.externalRef).toMatch(/^mock-/);
    expect(r2.externalRef).toBe(r1.externalRef);
  });

  it("samples service families proportionally to Market Lab weights (0% markets never appear)", async () => {
    const now = at("2026-09-26T10:05:00Z");
    const count = (items: { raw?: Record<string, unknown> }[]) => {
      const c: Record<string, number> = {};
      for (const o of items) if (!(o.raw as { crossPostOf?: string } | undefined)?.crossPostOf) c[String((o.raw as { family?: string }).family)] = (c[String((o.raw as { family?: string }).family)] ?? 0) + 1;
      return c;
    };
    const src = new MockSource({ now });
    const heavyAutomation = await src.fetchOpportunities({ tenantId: T, weights: [{ key: "ai-automation", weight: 80 }, { key: "image-design", weight: 20 }] });
    const heavyImage = await src.fetchOpportunities({ tenantId: T, weights: [{ key: "ai-automation", weight: 20 }, { key: "image-design", weight: 80 }] });
    const a = count(heavyAutomation);
    const b = count(heavyImage);
    expect(Object.keys(a).sort()).toEqual(["ai-automation", "image-design"]); // other markets have weight 0
    expect(a["ai-automation"]!).toBeGreaterThan(a["image-design"] ?? 0);
    expect(b["image-design"]!).toBeGreaterThan(b["ai-automation"] ?? 0);
    // Changing the allocation changes the batch (new ids), same allocation is stable.
    expect(heavyAutomation.map((o) => o.externalId)).not.toEqual(heavyImage.map((o) => o.externalId));
    const again = await src.fetchOpportunities({ tenantId: T, weights: [{ key: "ai-automation", weight: 80 }, { key: "image-design", weight: 20 }] });
    expect(again.map((o) => o.externalId)).toEqual(heavyAutomation.map((o) => o.externalId));
    // Unweighted calls keep the original feed.
    const plain = await src.fetchOpportunities({ tenantId: T });
    expect(new Set(plain.map((o) => (o.raw as { family?: string }).family)).size).toBe(6);
  });
});
