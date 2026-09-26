import "./testing/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@gigpilot/config";
import { InvalidTransitionError } from "@gigpilot/contracts";
import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import {
  agentEvent,
  agentRun,
  and,
  asc,
  auditEvent,
  closeDb,
  costLedgerEntry,
  eq,
  getDb,
  job,
  notification,
  repair,
  transition,
  workflowStep,
} from "@gigpilot/db";
import type { CreativeBroker } from "@gigpilot/providers";
import { createCreativeBroker } from "../../providers/src/broker";
import { handlers } from "./handlers";
import { AUTOMATION_BRIEF, IMAGE_BRIEF, createTestTenant, drain, migrateTestDb, resetDb, testDeps, wonJob } from "./testing/harness";

class PaidFake implements CreativeProvider {
  readonly paid = true;
  calls = 0;
  constructor(readonly key: string) {}
  isConfigured(): boolean {
    return true;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "fake", checkedAt: new Date().toISOString() };
  }
  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === this.key);
  }
  async generate(_req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    this.calls++;
    return { provider: this.key, model: option.model, status: "succeeded", files: [], costUsd: option.unitCostUsd ?? 0, costSource: "provider", latencyMs: 1 };
  }
}

/** Wraps a real broker and fails the first `failures` generate calls. */
function flakyBroker(failures: number): CreativeBroker & { attempts: number } {
  const real = createCreativeBroker();
  const b = {
    attempts: 0,
    plan: real.plan.bind(real),
    providers: real.providers.bind(real),
    configuredProviders: real.configuredProviders.bind(real),
    async generate(req: CreativeRequest, opts: Parameters<CreativeBroker["generate"]>[1]) {
      b.attempts++;
      if (b.attempts <= failures) throw new Error("upstream 503: provider temporarily unavailable");
      return real.generate(req, opts);
    },
  };
  return b;
}

async function stepsOf(jobId: string) {
  return getDb().select().from(workflowStep).where(eq(workflowStep.jobId, jobId)).orderBy(asc(workflowStep.position));
}

describe("workflow engine", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "0";
    resetEnvCache();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("plans a DAG and advances only valid, audited transitions", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    let [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("ready");
    const steps = await stepsOf(jobId);
    expect(steps.map((s) => s.key)).toEqual(["scope", "plan", "implement", "test", "review", "finalize"]);
    expect(steps.find((s) => s.key === "implement")!.input).toMatchObject({ simulateDefect: "failing_test" });
    expect(steps.find((s) => s.key === "review")!.maxAttempts).toBe(5); // maxRepairsPerJob + 1

    deps.queue.take("workflow-tick");
    const tick = await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    expect(tick).toMatchObject({ dispatched: ["scope"], readied: ["scope"] });
    [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("executing");
    // A duplicate tick does not re-dispatch the same attempt (singleton key) nor start blocked steps.
    const again = (await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps)) as { dispatched: string[] };
    expect(deps.queue.jobs.filter((x) => x.name === "step-execute")).toHaveLength(1);
    expect(again.dispatched).toEqual(["scope"]);

    // Stale dispatch (wrong attempt) is ignored.
    const scope = (await stepsOf(jobId))[0]!;
    expect(await handlers["step-execute"]({ tenantId: t.tenantId, jobId, stepId: scope.id, attempt: 2 }, deps)).toMatchObject({ status: "skipped" });

    // Direct invalid transitions are rejected by the state machine.
    await expect(transition(db, { machine: "job", id: jobId, tenantId: t.tenantId, to: "delivered", actor: { type: "system" } })).rejects.toBeInstanceOf(InvalidTransitionError);

    const audits = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, jobId));
    expect(audits.map((a) => `${a.fromState}->${a.toState}`)).toEqual(expect.arrayContaining(["intake->planning", "planning->ready", "ready->executing"]));
  });

  it("retries a failed step as a NEW agent_run (failed attempts are never overwritten)", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps({ broker: flakyBroker(1) });
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    await drain(deps);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
    const failedOnce = (await stepsOf(jobId)).find((s) => s.kind === "generate" && s.attempts >= 2)!;
    const runs = await db.select().from(agentRun).where(eq(agentRun.stepId, failedOnce.id)).orderBy(asc(agentRun.attempt));
    expect(runs[0]).toMatchObject({ attempt: 1, status: "failed" });
    expect(runs[0]!.error).toMatch(/upstream 503/);
    expect(runs.some((r) => r.attempt === 2 && r.status === "succeeded")).toBe(true);
  });

  it("stops at the step attempt limit and alerts the owner", async () => {
    const db = getDb();
    const t = await createTestTenant({ settings: { limits: { maxStepAttempts: 2 } } });
    const deps = testDeps({ broker: flakyBroker(1000) });
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    await drain(deps);
    const gen = (await stepsOf(jobId)).find((s) => s.kind === "generate")!;
    expect(gen.status).toBe("failed");
    expect(gen.attempts).toBe(2);
    const runs = await db.select().from(agentRun).where(eq(agentRun.stepId, gen.id));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "failed")).toBe(true);
    const alerts = await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.dedupeKey, `step-exhausted:${gen.id}`)));
    expect(alerts).toHaveLength(1);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("executing");
  });

  it("escalates instead of repairing when the repair limit is reached", async () => {
    const db = getDb();
    const t = await createTestTenant({ settings: { limits: { maxRepairsPerJob: 0 } } });
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    await drain(deps);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("repairing");
    expect(j!.repairCount).toBe(0);
    const repairs = await db.select().from(repair).where(eq(repair.jobId, jobId));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ strategy: "escalate", status: "blocked" });
    const events = await db.select().from(agentEvent).where(and(eq(agentEvent.jobId, jobId), eq(agentEvent.type, "repair.limit_reached")));
    expect(events).toHaveLength(1);
    const qa = (await stepsOf(jobId)).find((s) => s.agent === "qa")!;
    expect(qa.status).toBe("failed");
    expect(await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.kind, "alert")))).not.toHaveLength(0);
  });

  it("blocks a paid generation that would exceed the job spend limit (no spend, owner alerted)", async () => {
    const db = getDb();
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "5";
    resetEnvCache();
    const t = await createTestTenant({ settings: { limits: { dailyPaidSpendLimitUsd: 5 } } });
    const kie = new PaidFake("kie");
    const deps = testDeps({ broker: createCreativeBroker([kie]) });
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "5";
    resetEnvCache();
    const jobId = await wonJob(t, deps, IMAGE_BRIEF);
    await db.update(job).set({ spendLimitUsd: 0.001 }).where(eq(job.id, jobId));
    deps.queue.take("job-plan");
    await handlers["job-plan"]({ tenantId: t.tenantId, jobId }, deps);
    await drain(deps);

    const gen = (await stepsOf(jobId)).filter((s) => s.kind === "generate");
    expect(gen.some((s) => s.status === "blocked")).toBe(true);
    const blocked = gen.find((s) => s.status === "blocked")!;
    expect(blocked.output).toMatchObject({ blockedReason: "budget" });
    expect(blocked.attempts).toBe(1); // not retried
    expect(kie.calls).toBe(0);
    const paidRows = await db.select().from(costLedgerEntry).where(and(eq(costLedgerEntry.tenantId, t.tenantId), eq(costLedgerEntry.paid, true)));
    expect(paidRows).toHaveLength(0);
    const events = await db.select().from(agentEvent).where(and(eq(agentEvent.jobId, jobId), eq(agentEvent.type, "budget.blocked")));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.message).toMatch(/Blocked/);
  });
});
