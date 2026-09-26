import "./testing/setup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentEvent,
  application,
  closeDb,
  costLedgerEntry,
  delivery,
  eq,
  getDb,
  job,
  market,
  marketInsight,
  providerMetric,
  generation,
  qaReview,
  repair,
  sql,
  and,
} from "@gigpilot/db";
import { seedDemoHistory } from "@gigpilot/db/demo";
import { handlers } from "./handlers";
import { createTestTenant, drain, migrateTestDb, resetDb, testDeps } from "./testing/harness";

describe("demo history seeder", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("seeds consistent history fast, is idempotent, and coexists with the live pipeline", async () => {
    const db = getDb();
    const t = await createTestTenant({ mode: "demo" });
    const started = Date.now();
    await seedDemoHistory(db, t.tenantId);
    const ms = Date.now() - started;
    expect(ms).toBeLessThan(1500);

    const jobs = await db.select().from(job).where(eq(job.tenantId, t.tenantId));
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    expect(new Set(jobs.map((j) => j.serviceFamily)).size).toBeGreaterThanOrEqual(4);
    expect(jobs.every((j) => j.status === "delivered" || j.status === "closed")).toBe(true);

    // Estimate vs actual within ±20% for production cost lines that exist on both sides.
    for (const j of jobs) {
      const ledger = await db.select().from(costLedgerEntry).where(eq(costLedgerEntry.jobId, j.id));
      for (const cat of ["creative", "inference"] as const) {
        const est = ledger.filter((l) => l.category === cat && l.kind === "estimate").reduce((a, l) => a + l.amountUsd, 0);
        const act = ledger.filter((l) => l.category === cat && l.kind === "actual").reduce((a, l) => a + l.amountUsd, 0);
        if (est > 0 && act > 0) expect(Math.abs(act - est) / est).toBeLessThanOrEqual(0.2);
      }
      expect(ledger.some((l) => l.kind === "estimate")).toBe(true);
      expect(ledger.some((l) => l.kind === "actual")).toBe(true);
      expect(ledger.every((l) => !l.paid)).toBe(true);
    }

    const failedQa = await db.select().from(qaReview).where(and(eq(qaReview.tenantId, t.tenantId), eq(qaReview.verdict, "fail")));
    expect(failedQa.length).toBeGreaterThanOrEqual(1);
    const repairs = await db.select().from(repair).where(eq(repair.tenantId, t.tenantId));
    expect(repairs.some((r) => r.status === "succeeded")).toBe(true);
    const deliveries = await db.select().from(delivery).where(eq(delivery.tenantId, t.tenantId));
    expect(deliveries.every((d) => d.status === "approved")).toBe(true);

    const apps = await db.select({ status: application.status }).from(application).where(eq(application.tenantId, t.tenantId));
    for (const s of ["submitted", "client_response", "negotiating", "lost", "won"]) expect(apps.map((a) => a.status)).toContain(s);

    const markets = await db.select().from(market).where(eq(market.tenantId, t.tenantId));
    expect(markets).toHaveLength(6);
    expect(markets.every((m) => m.metrics !== null && m.recommendedAllocationPct !== null)).toBe(true);
    expect(markets.reduce((a, m) => a + (m.recommendedAllocationPct ?? 0), 0)).toBe(100);
    expect(await db.select().from(marketInsight).where(eq(marketInsight.tenantId, t.tenantId))).toHaveLength(1);

    // Simulated history never steers routing: no creative provider metrics are seeded.
    const metricsBefore = await db.select().from(providerMetric).where(eq(providerMetric.tenantId, t.tenantId));
    expect(metricsBefore.length).toBeGreaterThan(0);
    expect(metricsBefore.every((m) => m.capability === "inference")).toBe(true);
    const seededGens = await db.select({ params: generation.params }).from(generation).where(eq(generation.tenantId, t.tenantId));
    expect(seededGens.length).toBeGreaterThan(0);
    expect(seededGens.every((g) => (g.params as Record<string, unknown>).simulated === true)).toBe(true);

    // Idempotent: a second call is a no-op.
    await seedDemoHistory(db, t.tenantId);
    expect((await db.select().from(job).where(eq(job.tenantId, t.tenantId))).length).toBe(jobs.length);

    // Metrics rollup excludes simulated generations (and prunes creative rows they once produced).
    const deps = testDeps();
    await db.insert(providerMetric).values({ tenantId: t.tenantId, provider: "kie", model: "veo-3-1", capability: "video.generate", attempts: 19, successes: 19, qaPasses: 8, usableRate: 0.42 });
    const rollup = (await handlers["metrics-rollup"]({}, deps)) as { pruned: number };
    expect(rollup.pruned).toBeGreaterThanOrEqual(1);
    const after = await db.select().from(providerMetric).where(and(eq(providerMetric.tenantId, t.tenantId), eq(providerMetric.capability, "video.generate")));
    expect(after).toHaveLength(0);

    // The live pipeline runs on top of the history (no fresh opportunities were seeded).
    const [{ n: seededNew } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(agentEvent).where(and(eq(agentEvent.tenantId, t.tenantId), eq(agentEvent.type, "opportunity.discovered")));
    expect(seededNew).toBe(0);
    await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps);
    await handlers["market-research"]({ tenantId: t.tenantId }, deps);
    await drain(deps);
    const insights = await db.select().from(marketInsight).where(eq(marketInsight.tenantId, t.tenantId));
    expect(insights.length).toBe(2);
  });
});
