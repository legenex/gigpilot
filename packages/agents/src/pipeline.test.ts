import "./testing/setup";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentEvent,
  agentRun,
  and,
  asset,
  auditEvent,
  closeDb,
  costLedgerEntry,
  delivery,
  desc,
  eq,
  generation,
  getDb,
  job,
  opportunity,
  proposal,
  qaReview,
  repair,
  sql,
  workflowStep,
  application,
} from "@gigpilot/db";
import { getStorage } from "@gigpilot/providers";
import { approveFinalDelivery, approveOpportunity, approveProposal } from "./commands";
import { handlers } from "./handlers";
import { captureCommandQueue, createTestTenant, drain, migrateTestDb, mockCanDeliver, resetDb, testDeps } from "./testing/harness";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function count(table: any, where: ReturnType<typeof eq> | undefined): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return Number(row?.n ?? 0);
}

async function runJobToApproval(tenantId: string, ctx: Parameters<typeof approveOpportunity>[0], opportunityId: string, deps: ReturnType<typeof testDeps>) {
  const db = getDb();
  await approveOpportunity(ctx, opportunityId);
  await drain(deps);
  const [prop] = await db.select().from(proposal).where(and(eq(proposal.opportunityId, opportunityId), eq(proposal.status, "awaiting_approval"))).limit(1);
  expect(prop, "proposal drafted").toBeTruthy();
  await approveProposal(ctx, prop!.id);
  await drain(deps);
  const [j] = await db.select().from(job).where(and(eq(job.tenantId, tenantId), eq(job.opportunityId, opportunityId))).limit(1);
  return { prop: prop!, job: j! };
}

describe("full opportunity-to-delivery pipeline (mock mode)", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("sources, analyses, proposes, wins, produces, repairs, QA-passes and delivers", async () => {
    const db = getDb();
    const t = await createTestTenant({ mode: "demo" });
    const deps = testDeps();
    captureCommandQueue(deps.queue);

    // 1) Scout: mock marketplace refresh through the real pipeline.
    const refresh = (await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps)) as { inserted: number; fetched: number };
    expect(refresh.fetched).toBeGreaterThanOrEqual(25);
    expect(refresh.inserted).toBeGreaterThanOrEqual(15);

    // 2) Analyst + economics for every new opportunity.
    await drain(deps);
    const analysed = await db.select().from(opportunity).where(eq(opportunity.tenantId, t.tenantId));
    expect(analysed.filter((o) => o.status === "new" || o.status === "analysing")).toHaveLength(0);
    // Only deep analysis (refinement) may recommend pursuit — triage-only rows are at most "consider".
    const pursue = analysed.filter((o) => o.recommendation === "pursue");
    expect(pursue.length).toBeGreaterThanOrEqual(3);
    expect(analysed.some((o) => o.recommendation === "skip")).toBe(true);
    const refinedIds = new Set(
      (await db.select().from(agentEvent).where(and(eq(agentEvent.tenantId, t.tenantId), eq(agentEvent.type, "opportunity.analysed"))))
        .filter((e) => (e.data as Record<string, unknown>).refined === true)
        .map((e) => e.subjectId),
    );
    expect(pursue.every((o) => refinedIds.has(o.id))).toBe(true);

    // Pick the most profitable candidate the deterministic pipeline can honestly deliver
    // (e.g. a RAG assistant or a brief that requires tests escalates to the owner instead).
    const deliverable = [];
    for (const o of pursue) if (await mockCanDeliver(o)) deliverable.push(o);
    expect(deliverable.length).toBeGreaterThan(0);
    const best = [...deliverable].sort((a, b) => (b.expectedProfitUsd ?? 0) - (a.expectedProfitUsd ?? 0))[0]!;
    expect(best.status).toBe("shortlisted");
    expect(best.expectedProfitUsd!).toBeGreaterThanOrEqual(300);
    expect(best.expectedMargin!).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(best.budgetMaxUsd ?? 0, best.budgetMinUsd ?? 0, best.priceUsd ?? 0)).toBeGreaterThanOrEqual(300);

    // 3) Owner approves → proposal → owner approves → submit (mock) → award → plan → execute → QA → repair → QA → package.
    const { prop, job: j } = await runJobToApproval(t.tenantId, t.ctx, best.id, deps);
    expect(prop.coverLetter.length).toBeGreaterThan(200);
    expect(prop.priceUsd).toBeGreaterThan(0);
    expect(j, "job created by the demo award").toBeTruthy();

    const [app] = await db.select().from(application).where(eq(application.opportunityId, best.id)).limit(1);
    expect(app!.status).toBe("won");
    expect(app!.submissionMode).toBe("mock");

    const [finalJob] = await db.select().from(job).where(eq(job.id, j.id)).limit(1);
    expect(finalJob!.status).toBe("awaiting_final_approval");

    const reviews = await db.select().from(qaReview).where(eq(qaReview.jobId, j.id)).orderBy(qaReview.createdAt);
    expect(reviews.some((r) => r.verdict === "fail"), "QA caught the simulated defect").toBe(true);
    expect(reviews.some((r) => r.verdict === "pass")).toBe(true);
    const repairs = await db.select().from(repair).where(eq(repair.jobId, j.id));
    expect(repairs.some((r) => r.status === "succeeded")).toBe(true);
    expect(finalJob!.repairCount).toBeGreaterThanOrEqual(1);

    // Failed attempts are never overwritten: the repaired step has ≥ 2 runs.
    const repairedStepId = repairs[0]!.stepId!;
    const runs = await db.select().from(agentRun).where(eq(agentRun.stepId, repairedStepId));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const [repairedStep] = await db.select().from(workflowStep).where(eq(workflowStep.id, repairedStepId));
    expect(repairedStep!.attempts).toBeGreaterThanOrEqual(2);

    const [pkg] = await db.select().from(delivery).where(eq(delivery.jobId, j.id)).orderBy(desc(delivery.createdAt)).limit(1);
    expect(pkg!.status).toBe("prepared");
    const [zipAsset] = await db.select().from(asset).where(eq(asset.id, pkg!.packageAssetId!));
    const zip = unzipSync(await getStorage().get(zipAsset!.storageKey));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(["MANIFEST.md", "DELIVERY-NOTES.md", "QA-SUMMARY.md"]));
    const qaMd = strFromU8(zip["QA-SUMMARY.md"]!);
    expect(qaMd).toContain("## Verified deterministically");
    expect(qaMd).toContain("## Not verified");
    expect(qaMd).not.toMatch(/\bPASS\b/); // QA outcomes are never presented as test results
    expect(qaMd).toMatch(/simulated defect was injected \(demo mode\) and repaired/);
    expect(Object.keys(zip).length).toBeGreaterThan(5);

    // 4) Owner approves the final delivery.
    await approveFinalDelivery(t.ctx, j.id);
    const [delivered] = await db.select().from(job).where(eq(job.id, j.id)).limit(1);
    expect(delivered!.status).toBe("delivered");

    // Ledger has estimates AND actuals; history exists.
    expect(await count(costLedgerEntry, and(eq(costLedgerEntry.jobId, j.id), eq(costLedgerEntry.kind, "estimate")))).toBeGreaterThan(0);
    expect(await count(costLedgerEntry, and(eq(costLedgerEntry.jobId, j.id), eq(costLedgerEntry.kind, "actual")))).toBeGreaterThan(0);
    expect(await count(costLedgerEntry, and(eq(costLedgerEntry.tenantId, t.tenantId), eq(costLedgerEntry.paid, true)))).toBe(0);
    expect(await count(agentEvent, eq(agentEvent.tenantId, t.tenantId))).toBeGreaterThan(30);
    expect(await count(auditEvent, eq(auditEvent.tenantId, t.tenantId))).toBeGreaterThan(30);
    expect(await count(agentEvent, and(eq(agentEvent.jobId, j.id), eq(agentEvent.type, "qa.failed")))).toBeGreaterThanOrEqual(1);
    expect(await count(agentEvent, and(eq(agentEvent.jobId, j.id), eq(agentEvent.type, "repair.completed")))).toBeGreaterThanOrEqual(1);
  });

  it("runs a creative job end to end with an aspect-ratio defect repaired by image edit", async () => {
    const db = getDb();
    const t = await createTestTenant({ mode: "demo" });
    const deps = testDeps();
    captureCommandQueue(deps.queue);
    await handlers["source-refresh"]({ tenantId: t.tenantId, sourceKey: "mock" }, deps);
    await drain(deps);
    const creative = (await db.select().from(opportunity).where(eq(opportunity.tenantId, t.tenantId))).filter(
      (o) => (o.marketKey === "paid-social-ugc" || o.marketKey === "image-design") && ["analysed", "shortlisted"].includes(o.status) && (o.expectedProfitUsd ?? 0) > 0,
    );
    if (creative.length === 0) return; // feed mix is deterministic per tenant id; nothing creative this bucket
    const target = creative.sort((a, b) => (b.expectedProfitUsd ?? 0) - (a.expectedProfitUsd ?? 0))[0]!;
    const { job: j } = await runJobToApproval(t.tenantId, t.ctx, target.id, deps);
    const [finalJob] = await db.select().from(job).where(eq(job.id, j.id)).limit(1);
    expect(finalJob!.status).toBe("awaiting_final_approval");
    const gens = await db.select().from(generation).where(eq(generation.jobId, j.id));
    expect(gens.length).toBeGreaterThan(0);
    expect(gens.some((g) => g.repairOfId !== null)).toBe(true);
    expect(gens.every((g) => g.status === "succeeded")).toBe(true);
    const failed = await db.select().from(qaReview).where(and(eq(qaReview.jobId, j.id), eq(qaReview.verdict, "fail")));
    expect(failed.some((r) => r.findings.some((f) => f.code === "aspect_ratio"))).toBe(true);
  });
});
