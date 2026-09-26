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

    const metricsBefore = await db.select().from(providerMetric).where(eq(providerMetric.tenantId, t.tenantId));
    expect(metricsBefore.length).toBeGreaterThan(0);

    // Idempotent: a second call is a no-op.
    await seedDemoHistory(db, t.tenantId);
    expect((await db.select().from(job).where(eq(job.tenantId, t.tenantId))).length).toBe(jobs.length);

    // Metrics rollup reproduces the seeded creative metrics (history is internally consistent).
    const deps = testDeps();
    await handlers["metrics-rollup"]({}, deps);
    const after = await db.select().from(providerMetric).where(and(eq(providerMetric.tenantId, t.tenantId), eq(providerMetric.capability, "video.generate")));
    const before = metricsBefore.find((m) => m.capability === "video.generate")!;
    expect(after[0]!.attempts).toBe(before.attempts);
    expect(after[0]!.usableRate).toBeCloseTo(before.usableRate ?? 0, 3);

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
