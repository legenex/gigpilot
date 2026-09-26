import "./testing/setup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, auditEvent, closeDb, costLedgerEntry, eq, getDb, job, opportunity, workflowStep } from "@gigpilot/db";
import { approveFinalDelivery } from "./commands";
import { handlers } from "./handlers";
import { AUTOMATION_BRIEF, createTestTenant, drain, insertOpportunity, migrateTestDb, resetDb, testDeps, wonJob } from "./testing/harness";

describe("maintenance jobs", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("expires stale opportunities and purges content whose source cache window has passed", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const stale = await insertOpportunity(t, { ...AUTOMATION_BRIEF, title: "Old brief nobody picked up for a week" });
    await db.update(opportunity).set({ postedAt: new Date(Date.now() - 10 * 86_400_000), deadlineAt: null }).where(eq(opportunity.id, stale));
    const upwork = await insertOpportunity(t, { ...AUTOMATION_BRIEF, title: "Upwork listing with a 24h cache limit", sourceKey: "upwork" });
    await db
      .update(opportunity)
      .set({ raw: { cacheExpiresAt: new Date(Date.now() - 60_000).toISOString(), triageBudget: "ok", secretish: "listing body" } })
      .where(eq(opportunity.id, upwork));
    const fresh = await insertOpportunity(t, { ...AUTOMATION_BRIEF, title: "Fresh brief posted today" });

    const res = (await handlers["opportunity-expire"]({}, deps)) as { expired: number; purged: number };
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(res.purged).toBe(1);
    const rows = await db.select().from(opportunity).where(eq(opportunity.tenantId, t.tenantId));
    expect(rows.find((r) => r.id === stale)!.status).toBe("expired");
    expect(rows.find((r) => r.id === fresh)!.status).toBe("new");
    const purged = rows.find((r) => r.id === upwork)!;
    expect(purged.description).toMatch(/Content purged/);
    expect(purged.raw).toMatchObject({ purgeReason: expect.stringMatching(/cache window/) });
    expect(JSON.stringify(purged.raw)).not.toContain("listing body");
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.subjectId, upwork), eq(auditEvent.action, "opportunity.content_purged")));
    expect(audits).toHaveLength(1);
    // Idempotent: nothing left to purge.
    expect(((await handlers["opportunity-expire"]({}, deps)) as { purged: number }).purged).toBe(0);
  });

  it("job monitor fails stuck steps so the engine retries them, and delivery approval records actuals", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const dispatched = deps.queue.take("step-execute")[0]!;
    const stepId = (dispatched.payload as { stepId: string }).stepId;
    // Simulate a worker that died mid-step 40 minutes ago.
    await db.update(workflowStep).set({ status: "running", attempts: 1, startedAt: new Date(Date.now() - 40 * 60_000) }).where(eq(workflowStep.id, stepId));
    const mon = (await handlers["job-monitor"]({}, deps)) as { stuckSteps: number };
    expect(mon.stuckSteps).toBe(1);
    const [s] = await db.select().from(workflowStep).where(eq(workflowStep.id, stepId));
    expect(s!.status).toBe("failed");
    expect(s!.error).toMatch(/Timed out/);
    await drain(deps);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
    const [retried] = await db.select().from(workflowStep).where(eq(workflowStep.id, stepId));
    expect(retried!.status).toBe("succeeded");
    expect(retried!.attempts).toBe(2);

    await approveFinalDelivery(t.ctx, jobId);
    const ledger = await db.select().from(costLedgerEntry).where(eq(costLedgerEntry.jobId, jobId));
    expect(ledger.filter((l) => l.category === "revenue" && l.kind === "actual")).toHaveLength(1);
    expect(ledger.filter((l) => l.category === "marketplace_fee" && l.kind === "actual")).toHaveLength(1);

    const note = await handlers["notifications-dispatch"]({}, deps);
    expect(note).toMatchObject({ purged: 0 });
    const rollup = (await handlers["metrics-rollup"]({}, deps)) as { upserts: number };
    expect(rollup.upserts).toBeGreaterThan(0);
  });
});
