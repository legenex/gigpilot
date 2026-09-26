import "./testing/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { resetEnvCache } from "@gigpilot/config";
import { InvalidTransitionError } from "@gigpilot/contracts";
import type {
  CreativeModelOption,
  CreativeOutput,
  CreativeProvider,
  CreativeRequest,
  IntelligenceProvider,
  IntelligenceRequest,
  IntelligenceResult,
  ProviderHealth,
} from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import {
  agentEvent,
  agentRun,
  and,
  application,
  asc,
  asset,
  auditEvent,
  closeDb,
  costLedgerEntry,
  delivery,
  desc,
  eq,
  getDb,
  job,
  market,
  notification,
  opportunity,
  opportunityAnalysis,
  providerIntegration,
  qaReview,
  spendReservation,
  StaleTransitionError,
  transition,
  workflowStep,
} from "@gigpilot/db";
import type { StorageAdapter } from "@gigpilot/providers";
import { getStorage } from "@gigpilot/providers/storage";
import { createCreativeBroker } from "../../providers/src/broker";
import { MockCreativeProvider } from "../../providers/src/creative/mock";
import { ProviderError } from "../../providers/src/lib/errors";
import { MockIntelligenceProvider } from "../../providers/src/intelligence/mock";
import { createIntelligenceRouter } from "../../providers/src/router";
import { safeArchivePath, zipArtifact } from "./agents/execution";
import { STEP_STUCK_MS, runOutboxSweep } from "./agents/maintenance";
import {
  CommandError,
  cancelJob,
  confirmJobInputs,
  ingestInboundOpportunity,
  jobBlockers,
  recordIntegrationHealth,
  requestJobRevision,
  requestProposal,
  resumeJob,
  setJobSpendLimit,
  updateMarkets,
} from "./commands";
import { handlers } from "./handlers";
import { BudgetBlockedError, callCreative, callIntelligence, runAgent } from "./runtime";
import {
  AUTOMATION_BRIEF,
  IMAGE_BRIEF,
  approvedApplication,
  captureCommandQueue,
  createTestTenant,
  drain,
  insertOpportunity,
  migrateTestDb,
  resetDb,
  testDeps,
  wonJob,
} from "./testing/harness";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** GX-family intelligence: after arm(n), the next n calls wait for open() (or reject on abort). */
class GatedIntelligence implements IntelligenceProvider {
  readonly family = "gx" as const;
  readonly paid = false;
  calls = 0;
  gatedCalls = 0;
  private armed = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => (this.release = r));
  constructor(private readonly leak?: string) {}
  arm(n = 1): void {
    this.armed = n;
  }
  open(): void {
    this.release();
  }
  isConfigured(): boolean {
    return true;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "fake", checkedAt: new Date().toISOString() };
  }
  supports(): boolean {
    return true;
  }
  estimateCost(): number {
    return 0;
  }
  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    this.calls++;
    if (this.armed > 0) {
      this.armed--;
      this.gatedCalls++;
      await Promise.race([
        this.gate,
        new Promise<never>((_, reject) => {
          if (req.signal?.aborted) reject(new Error("aborted"));
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
    }
    let data: T | undefined = req.mockResult ? await req.mockResult() : undefined;
    if (this.leak && data && typeof data === "object" && "markdown" in (data as object)) {
      const md = (data as unknown as { markdown: string }).markdown;
      data = { ...(data as object), markdown: `${md}\n\nconfig: ${this.leak}` } as unknown as T;
    }
    return { family: "gx", model: "gx-test", text: JSON.stringify(data ?? {}), data, usage: { inputTokens: 10, outputTokens: 10, costUsd: 0, costSource: "free" }, latencyMs: 1 };
  }
}

/** Paid "kie" that renders real (mock) files but bills like a live provider. */
class PaidRender implements CreativeProvider {
  readonly paid = true;
  calls = 0;
  constructor(
    readonly key: string,
    private readonly opts: { models?: CreativeModelOption[]; delayMs?: number; costUsd?: number; throwAmbiguous?: boolean } = {},
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "fake", checkedAt: new Date().toISOString() };
  }
  models(): CreativeModelOption[] {
    return this.opts.models ?? CREATIVE_CATALOG.filter((m) => m.provider === this.key);
  }
  async generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    this.calls++;
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.throwAmbiguous) throw new ProviderError(this.key, "ambiguous_submission", "createTask timed out — the task may exist; not retried automatically", { retryable: false });
    const out = await new MockCreativeProvider().render({ ...req, signal: undefined }, option, null);
    return { ...out, provider: this.key, model: option.model, costUsd: this.opts.costUsd ?? option.unitCostUsd ?? 0, costSource: "provider" };
  }
}

async function stepsOf(jobId: string) {
  return getDb().select().from(workflowStep).where(eq(workflowStep.jobId, jobId)).orderBy(asc(workflowStep.position));
}

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

function enablePaid(usd = 5) {
  process.env.PAID_PROVIDER_DAILY_BUDGET_USD = String(usd);
  // Operator grants non-operator workspaces a paid ceiling explicitly (security H1).
  process.env.TENANT_MAX_DAILY_PAID_USD = String(usd);
  resetEnvCache();
}

describe("reliability repairs", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "0";
    process.env.TENANT_MAX_DAILY_PAID_USD = "0";
    resetEnvCache();
  });
  afterAll(async () => {
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // Owner escalation paths
  // -------------------------------------------------------------------------

  it("live jobs waiting for inputs: reminded, surfaced, and confirmed by the owner (audited → ready → production)", async () => {
    const db = getDb();
    const t = await createTestTenant({ mode: "live" });
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF);
    const [j0] = await db.select().from(job).where(eq(job.id, jobId));
    const [a] = await db.select().from(opportunityAnalysis).where(eq(opportunityAnalysis.opportunityId, j0!.opportunityId!)).orderBy(desc(opportunityAnalysis.version)).limit(1);
    await db.update(opportunityAnalysis).set({ analysis: { ...a!.analysis, missingInputs: ["HubSpot sandbox credentials"] } }).where(eq(opportunityAnalysis.id, a!.id));
    deps.queue.take("job-plan");
    await handlers["job-plan"]({ tenantId: t.tenantId, jobId }, deps);
    let [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_inputs");
    const blockers = await jobBlockers(t.tenantId, jobId);
    expect(blockers).toMatchObject({ awaitingInputs: true, canConfirmInputs: true, canResume: false, missingInputs: ["HubSpot sandbox credentials"] });

    // Long waits are surfaced once per day.
    const later = testDeps({ queue: deps.queue, now: () => new Date(Date.now() + 26 * 3_600_000) });
    const mon = (await handlers["job-monitor"]({}, later)) as { inputReminders: number };
    expect(mon.inputReminders).toBe(1);
    expect(((await handlers["job-monitor"]({}, later)) as { inputReminders: number }).inputReminders).toBe(0);

    await expect(requestJobRevision(t.ctx, jobId, "please change the colours")).rejects.toBeInstanceOf(CommandError);
    captureCommandQueue(deps.queue);
    deps.queue.take("workflow-tick");
    await confirmJobInputs(t.ctx, jobId, "Client shared sandbox access by email");
    [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("ready");
    expect(deps.queue.jobs.some((x) => x.name === "workflow-tick")).toBe(true);
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.subjectId, jobId), eq(auditEvent.action, "job.inputs_confirmed")));
    expect(audits[0]!.data).toMatchObject({ note: "Client shared sandbox access by email" });
    await expect(confirmJobInputs(t.ctx, jobId)).rejects.toBeInstanceOf(CommandError);

    // Live workspace + mock-only providers: deliverables are flagged, never silently shipped.
    await drain(deps);
    [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("repairing");
    const reviews = await db.select().from(qaReview).where(eq(qaReview.jobId, jobId));
    expect(reviews.some((r) => r.findings.some((f) => f.code === "produced_by_mock" && f.severity === "major"))).toBe(true);
    const qa = (await stepsOf(jobId)).find((s) => s.agent === "qa")!;
    expect(qa.status).toBe("blocked");
    expect(qa.output).toMatchObject({ blockedReason: "repair_limit" });
    expect((await jobBlockers(t.tenantId, jobId)).repairLimitReached).toBe(true);
  });

  it("setJobSpendLimit: validated against actual spend and the operator ceiling, re-queues budget-blocked steps", async () => {
    const db = getDb();
    enablePaid(5);
    const t = await createTestTenant({ settings: { limits: { dailyPaidSpendLimitUsd: 5 } } });
    const kie = new PaidRender("kie");
    const deps = testDeps({ broker: createCreativeBroker([kie]) });
    const jobId = await wonJob(t, deps, IMAGE_BRIEF);
    await db.update(job).set({ spendLimitUsd: 0.001 }).where(eq(job.id, jobId));
    deps.queue.take("job-plan");
    await handlers["job-plan"]({ tenantId: t.tenantId, jobId }, deps);
    await drain(deps);
    const blocked = (await stepsOf(jobId)).filter((s) => s.status === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    expect(kie.calls).toBe(0);
    expect((await jobBlockers(t.tenantId, jobId)).budgetBlocked).toBe(true);

    captureCommandQueue(deps.queue);
    await expect(setJobSpendLimit(t.ctx, jobId, 6)).rejects.toThrow(/ceiling of \$5\.00/);
    await db.update(job).set({ actualCostUsd: 0.5 }).where(eq(job.id, jobId));
    await expect(setJobSpendLimit(t.ctx, jobId, 0.25)).rejects.toThrow(/already spent/);
    await db.update(job).set({ actualCostUsd: 0 }).where(eq(job.id, jobId));
    const res = await setJobSpendLimit(t.ctx, jobId, 4);
    expect(res.requeuedSteps.length).toBe(blocked.length);
    for (const s of await stepsOf(jobId)) if (blocked.some((b) => b.id === s.id)) expect(s.status).toBe("ready");
    const audit = await db.select().from(auditEvent).where(and(eq(auditEvent.subjectId, jobId), eq(auditEvent.action, "job.spend_limit_changed")));
    expect(audit[0]!.data).toMatchObject({ toUsd: 4 });

    await drain(deps);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
    expect(kie.calls).toBeGreaterThan(0);
    const paid = await db.select().from(costLedgerEntry).where(and(eq(costLedgerEntry.jobId, jobId), eq(costLedgerEntry.paid, true)));
    expect(paid.reduce((acc, r) => acc + Number(r.amountUsd), 0)).toBeLessThanOrEqual(4);
    const open = await db.select().from(spendReservation).where(and(eq(spendReservation.tenantId, t.tenantId), eq(spendReservation.status, "open")));
    expect(open).toHaveLength(0);
  });

  it("restricts revisions to awaiting_final_approval/delivered and processes them from repairing", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    captureCommandQueue(deps.queue);
    await expect(requestJobRevision(t.ctx, jobId, "change the tone")).rejects.toThrow(/delivery package is ready/);
    await drain(deps);
    let [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
    expect((await jobBlockers(t.tenantId, jobId)).canRequestRevision).toBe(true);
    await requestJobRevision(t.ctx, jobId, "Please add a section on error alerts");
    [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("repairing");
    await drain(deps);
    [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
    const deliveries = await db.select().from(delivery).where(eq(delivery.jobId, jobId));
    expect(deliveries.map((d) => d.status).sort()).toEqual(["prepared", "rejected"]);
  });

  // -------------------------------------------------------------------------
  // Delivery failure recovery
  // -------------------------------------------------------------------------

  it("delivery packaging failures end in `failed` (never stuck in preparing) and the job monitor re-queues them, bounded", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const real = getStorage();
    let failPackage = true;
    const storage: StorageAdapter = {
      driver: real.driver,
      put: async (key, data, mime) => {
        if (failPackage && key.endsWith("-delivery.zip")) throw new Error("storage unavailable (disk full)");
        return real.put(key, data, mime);
      },
      get: (k) => real.get(k),
      exists: (k) => real.exists(k),
      delete: (k) => real.delete(k),
      health: () => real.health(),
    };
    const deps = testDeps({ storage });
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    await drain(deps, { hold: ["delivery-prepare"] });
    const payload = deps.queue.take("delivery-prepare")[0]!.payload as { tenantId: string; jobId: string };
    await expect(handlers["delivery-prepare"](payload, deps)).rejects.toThrow(/disk full/);
    let [d] = await db.select().from(delivery).where(eq(delivery.jobId, jobId));
    expect(d).toMatchObject({ status: "failed", attempts: 1 });
    expect(d!.error).toMatch(/disk full/);
    await expect(handlers["delivery-prepare"](payload, deps)).rejects.toThrow(/disk full/);
    const third = await handlers["delivery-prepare"](payload, deps); // per-round budget spent → stop throwing
    expect(third).toMatchObject({ status: "failed", attempts: 3 });
    [d] = await db.select().from(delivery).where(eq(delivery.jobId, jobId));
    expect(d!.status).toBe("failed");
    expect((await jobBlockers(t.tenantId, jobId)).deliveryFailed).toBe(true);

    // The monitor re-queues it; once storage recovers the package is prepared.
    failPackage = false;
    const mon = (await handlers["job-monitor"]({}, deps)) as { deliveriesRequeued: number };
    expect(mon.deliveriesRequeued).toBe(1);
    await drain(deps);
    [d] = await db.select().from(delivery).where(eq(delivery.jobId, jobId));
    expect(d!.status).toBe("prepared");
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
  });

  it("the monitor re-queues stale `preparing` deliveries and alerts instead once the bound is reached", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    await drain(deps, { hold: ["delivery-prepare"] });
    deps.queue.take("delivery-prepare");
    const [row] = await db.insert(delivery).values({ tenantId: t.tenantId, jobId, status: "preparing", attempts: 1, updatedAt: new Date(Date.now() - 30 * 60_000) }).returning();
    expect(((await handlers["job-monitor"]({}, deps)) as { deliveriesRequeued: number }).deliveriesRequeued).toBe(1);
    expect(deps.queue.take("delivery-prepare")).toHaveLength(1);
    await db.update(delivery).set({ attempts: 99, updatedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(delivery.id, row!.id));
    expect(((await handlers["job-monitor"]({}, deps)) as { deliveriesRequeued: number }).deliveriesRequeued).toBe(0);
    const alerts = await db.select().from(notification).where(eq(notification.dedupeKey, `delivery-failed:${row!.id}`));
    expect(alerts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Duplicate execution, claims, shutdown, cancellation
  // -------------------------------------------------------------------------

  it("transition(): expectFrom is checked before the no-op shortcut and requireChange makes it a claim", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const scope = (await stepsOf(jobId))[0]!;
    expect(scope.status).toBe("ready");
    const claim = () => transition(db, { machine: "step", id: scope.id, tenantId: t.tenantId, to: "running", actor: { type: "system" }, expectFrom: ["ready"], requireChange: true, match: { attempts: 0 }, patch: { attempts: 1 } });
    const results = await Promise.allSettled([claim(), claim()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason instanceof StaleTransitionError || rejected.reason instanceof InvalidTransitionError).toBe(true);
    // Same state, but not from an allowed state → rejected (no silent no-op).
    await expect(transition(db, { machine: "step", id: scope.id, tenantId: t.tenantId, to: "running", actor: { type: "system" }, expectFrom: ["ready"] })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(transition(db, { machine: "step", id: scope.id, tenantId: t.tenantId, to: "running", actor: { type: "system" }, requireChange: true })).rejects.toBeInstanceOf(StaleTransitionError);
    // Plain idempotent no-op still works.
    expect(await transition(db, { machine: "step", id: scope.id, tenantId: t.tenantId, to: "running", actor: { type: "system" } })).toMatchObject({ changed: false });
  });

  it("discards a late result from an attempt that timed out and was retried (no overwrite of the newer attempt)", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const gx = new GatedIntelligence();
    const deps = testDeps({ router: createIntelligenceRouter([gx, new MockIntelligenceProvider()]) });
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const first = deps.queue.take("step-execute")[0]!.payload as { tenantId: string; jobId: string; stepId: string; attempt: number };
    gx.arm(1);
    const late = handlers["step-execute"](first, deps);
    await waitFor(async () => (await db.select().from(workflowStep).where(eq(workflowStep.id, first.stepId)))[0]!.status === "running" && gx.gatedCalls >= 1);

    // The job monitor declares it stuck (past expiry + grace) and the engine retries as attempt 2.
    const monitorDeps = testDeps({ queue: deps.queue, now: () => new Date(Date.now() + STEP_STUCK_MS + 120_000) });
    expect(((await handlers["job-monitor"]({}, monitorDeps)) as { stuckSteps: number }).stuckSteps).toBe(1);
    deps.queue.take("step-execute");
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const second = deps.queue.take("step-execute").find((x) => (x.payload as { stepId: string }).stepId === first.stepId)!.payload as typeof first;
    expect(second.attempt).toBe(2);
    expect(await handlers["step-execute"](second, deps)).toMatchObject({ status: "succeeded" });

    gx.open(); // the timed-out attempt 1 finally returns
    expect(await late).toMatchObject({ status: "stale" });
    const [s] = await db.select().from(workflowStep).where(eq(workflowStep.id, first.stepId));
    expect(s).toMatchObject({ status: "succeeded", attempts: 2 });
    const stale = await db.select().from(agentEvent).where(and(eq(agentEvent.subjectId, first.stepId), eq(agentEvent.type, "step.stale_result")));
    expect(stale).toHaveLength(1);
  });

  it("a step interrupted by worker shutdown returns to ready WITHOUT consuming an attempt, then resumes", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const gx = new GatedIntelligence();
    const deps = testDeps({ router: createIntelligenceRouter([gx, new MockIntelligenceProvider()]) });
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const payload = deps.queue.take("step-execute")[0]!.payload as { tenantId: string; jobId: string; stepId: string; attempt: number };
    gx.arm(1);
    const shutdown = new AbortController();
    const running = handlers["step-execute"](payload, { ...deps, signal: shutdown.signal, shutdown: shutdown.signal });
    await waitFor(async () => gx.gatedCalls >= 1);
    shutdown.abort();
    expect(await running).toMatchObject({ status: "interrupted" });
    let [s] = await db.select().from(workflowStep).where(eq(workflowStep.id, payload.stepId));
    expect(s).toMatchObject({ status: "ready", attempts: 0 });
    expect(await db.select().from(agentEvent).where(and(eq(agentEvent.subjectId, payload.stepId), eq(agentEvent.type, "step.interrupted")))).toHaveLength(1);

    gx.open();
    await drain(deps);
    [s] = await db.select().from(workflowStep).where(eq(workflowStep.id, payload.stepId));
    expect(s).toMatchObject({ status: "succeeded", attempts: 1 });
    const runs = await db.select().from(agentRun).where(eq(agentRun.stepId, payload.stepId)).orderBy(asc(agentRun.createdAt));
    expect(runs.map((r) => `${r.attempt}:${r.status}`)).toEqual(["1:cancelled", "1:succeeded"]);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("awaiting_final_approval");
  });

  it("cancelJob cascades to steps and runs; the running handler stops at its checkpoint without writing results", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const gx = new GatedIntelligence();
    const deps = testDeps({ router: createIntelligenceRouter([gx, new MockIntelligenceProvider()]) });
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    deps.queue.take("workflow-tick");
    await handlers["workflow-tick"]({ tenantId: t.tenantId, jobId }, deps);
    const payload = deps.queue.take("step-execute")[0]!.payload as { tenantId: string; jobId: string; stepId: string; attempt: number };
    gx.arm(1);
    const running = handlers["step-execute"](payload, deps);
    await waitFor(async () => gx.gatedCalls >= 1);

    const counts = await cancelJob(t.ctx, jobId, "client withdrew");
    expect(counts.steps).toBeGreaterThan(1);
    expect(counts.runs).toBeGreaterThanOrEqual(1);
    gx.open();
    expect(await running).toMatchObject({ status: "cancelled" });
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("cancelled");
    const steps = await stepsOf(jobId);
    expect(steps.every((s) => s.status === "cancelled")).toBe(true);
    const runs = await db.select().from(agentRun).where(eq(agentRun.jobId, jobId));
    expect(runs.filter((r) => r.status === "queued" || r.status === "running")).toHaveLength(0);
    expect(runs.find((r) => r.stepId === payload.stepId)!.status).toBe("cancelled");
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.subjectId, payload.stepId), eq(auditEvent.toState, "cancelled")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // Nothing further runs for a cancelled job.
    await drain(deps);
    expect((await stepsOf(jobId)).every((s) => s.status === "cancelled")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Spend limits are hard limits
  // -------------------------------------------------------------------------

  it("budget reservation: two concurrent paid calls cannot exceed the limit", async () => {
    const db = getDb();
    enablePaid(5);
    const t = await createTestTenant({ settings: { limits: { dailyPaidSpendLimitUsd: 5 } } });
    const pricey: CreativeModelOption = { provider: "kie", model: "fake-pricey", capability: "image.generate", unitCostUsd: 3, unit: "image", qualityPrior: 0.95, usableRatePrior: 0.95, avgLatencySec: 1 };
    const kie = new PaidRender("kie", { models: [pricey], delayMs: 150, costUsd: 3 });
    const deps = testDeps({ broker: createCreativeBroker([kie]) });
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    await db.update(job).set({ spendLimitUsd: 100 }).where(eq(job.id, jobId));
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    const step = (await stepsOf(jobId)).find((s) => s.kind === "generate")!;
    const call = (i: number) =>
      runAgent({ deps, tenantId: t.tenantId, agent: "creative", task: "race", jobId, stepId: step.id }, (ctx) =>
        callCreative(ctx, { job: j!, step, capability: "image.generate", prompt: "Headline: Race\nSubhead: test", aspectRatio: "1:1", idempotencyKey: `race:${i}`, label: `race ${i}` }),
      );
    const results = await Promise.allSettled([call(1), call(2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(BudgetBlockedError);
    expect(kie.calls).toBe(1);
    const paid = await db.select().from(costLedgerEntry).where(and(eq(costLedgerEntry.tenantId, t.tenantId), eq(costLedgerEntry.paid, true)));
    expect(paid.reduce((acc, r) => acc + Number(r.amountUsd), 0)).toBeLessThanOrEqual(5);
    const reservations = await db.select().from(spendReservation).where(eq(spendReservation.tenantId, t.tenantId));
    expect(reservations.map((r) => r.status)).toEqual(["settled"]);
  });

  it("a finished creative unit is reused on retry (not regenerated or re-paid) and failed attempts keep their own rows", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    const step = (await stepsOf(jobId)).find((s) => s.kind === "generate")!;
    const real = createCreativeBroker();
    let fail = true;
    deps.broker = {
      plan: real.plan.bind(real),
      providers: real.providers.bind(real),
      configuredProviders: real.configuredProviders.bind(real),
      async generate(req: CreativeRequest, opts: Parameters<typeof real.generate>[1]) {
        if (fail) throw new Error("upstream 503");
        return real.generate(req, opts);
      },
    } as typeof real;
    const input = { job: j!, step, capability: "image.generate" as const, prompt: "Headline: Reuse", aspectRatio: "1:1" as const, idempotencyKey: `gen:${step.id}:base:0`, label: "unit #1" };
    await expect(runAgent({ deps, tenantId: t.tenantId, agent: "creative", task: "u", jobId, stepId: step.id }, (ctx) => callCreative(ctx, input))).rejects.toThrow(/503/);
    fail = false;
    const ok = await runAgent({ deps, tenantId: t.tenantId, agent: "creative", task: "u", jobId, stepId: step.id }, (ctx) => callCreative(ctx, input));
    expect(ok.reused).toBe(false);
    const again = await runAgent({ deps, tenantId: t.tenantId, agent: "creative", task: "u", jobId, stepId: step.id }, (ctx) => callCreative(ctx, input));
    expect(again).toMatchObject({ reused: true, generationId: ok.generationId });
    expect(again.assets.length).toBeGreaterThan(0);
    const { generation } = await import("@gigpilot/db");
    const rows = await db.select().from(generation).where(eq(generation.unitKey, input.idempotencyKey)).orderBy(asc(generation.createdAt));
    expect(rows.map((r) => `${r.idempotencyKey}:${r.status}`)).toEqual([`${input.idempotencyKey}#1:failed`, `${input.idempotencyKey}#2:succeeded`]);
  });

  it("an ambiguous paid submission blocks the step (owner must verify), records pending spend and is never retried automatically", async () => {
    const db = getDb();
    enablePaid(5);
    const t = await createTestTenant({ settings: { limits: { dailyPaidSpendLimitUsd: 5 } } });
    const kie = new PaidRender("kie", { throwAmbiguous: true });
    const deps = testDeps({ broker: createCreativeBroker([kie]) });
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    await drain(deps);
    const gens = (await stepsOf(jobId)).filter((s) => s.kind === "generate" && s.status === "blocked");
    expect(gens.length).toBeGreaterThan(0);
    for (const g of gens) {
      expect(g.output).toMatchObject({ blockedReason: "ambiguous_submission" });
      expect(g.attempts).toBe(1);
    }
    expect(kie.calls).toBe(gens.length); // one call per step, no retries
    const alerts = await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.dedupeKey, `ambiguous-step:${gens[0]!.id}:1`)));
    expect(alerts[0]!.title).toMatch(/Verify on kie/);
    const pending = await db.select().from(costLedgerEntry).where(and(eq(costLedgerEntry.jobId, jobId), eq(costLedgerEntry.paid, true)));
    expect(pending.some((p) => p.memo.startsWith("pending: provider task may be billed"))).toBe(true);
    const [j] = await db.select().from(job).where(eq(job.id, jobId));
    expect(j!.status).toBe("executing");
    const blockers = await jobBlockers(t.tenantId, jobId);
    expect(blockers.blockedSteps.map((b) => b.reason)).toContain("ambiguous_submission");
    expect(blockers.canResume).toBe(true);

    // After verifying on the provider, the owner resumes: the step is re-opened (new attempt window).
    captureCommandQueue(deps.queue);
    await resumeJob(t.ctx, jobId);
    const reopened = (await stepsOf(jobId)).find((s) => s.id === gens[0]!.id)!;
    expect(reopened.status).toBe("ready");
    expect((reopened.output as Record<string, unknown>).blockedReason).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Outbox sweeper, applications, proposals
  // -------------------------------------------------------------------------

  it("outbox sweeper re-enqueues lost follow-up work (bounded, then alerts the owner)", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, AUTOMATION_BRIEF);
    const applicationId = await approvedApplication(t, deps, oppId);
    const old = new Date(Date.now() - 10 * 60_000);
    await db.update(application).set({ updatedAt: old }).where(eq(application.id, applicationId));
    const pursuedId = await insertOpportunity(t, { ...AUTOMATION_BRIEF, title: "Second automation brief nobody drafted" });
    await db.update(opportunity).set({ status: "pursuing", updatedAt: old }).where(eq(opportunity.id, pursuedId));
    const jobId = await wonJob(t, testDeps(), IMAGE_BRIEF);
    await db.update(job).set({ updatedAt: old }).where(eq(job.id, jobId));
    deps.queue.take("application-submit");
    deps.queue.take("proposal-generate");
    deps.queue.take("job-plan");

    const first = await runOutboxSweep(deps);
    expect(first.requeued).toBe(3);
    expect(deps.queue.take("application-submit").map((x) => (x.payload as { applicationId: string }).applicationId)).toEqual([applicationId]);
    expect(deps.queue.take("proposal-generate").map((x) => (x.payload as { opportunityId: string }).opportunityId)).toEqual([pursuedId]);
    expect(deps.queue.take("job-plan").map((x) => (x.payload as { jobId: string }).jobId)).toEqual([jobId]);
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.subjectId, applicationId), eq(auditEvent.action, "outbox.requeued")));
    expect(audits).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      await runOutboxSweep(deps);
      deps.queue.take("application-submit");
      deps.queue.take("proposal-generate");
      deps.queue.take("job-plan");
    }
    const final = await runOutboxSweep(deps);
    expect(final).toMatchObject({ requeued: 0, exhausted: 3 });
    const alerts = await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.dedupeKey, `outbox-exhausted:application_submit:${applicationId}`)));
    expect(alerts).toHaveLength(1);
  });

  it("application submit releases its claim on a pre-call failure (the retry submits instead of reporting success)", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, AUTOMATION_BRIEF);
    const applicationId = await approvedApplication(t, deps, oppId);
    const { getSourceAdapter } = await import("../../providers/src/sources");
    const mock = getSourceAdapter("mock")!;
    let failures = 1;
    const flaky = Object.create(mock) as typeof mock;
    flaky.submit = async (req) => {
      if (failures-- > 0) throw new ProviderError("mock", "unavailable", "marketplace API temporarily unavailable");
      return mock.submit!(req);
    };
    const withFlaky = testDeps({ queue: deps.queue, sources: (k) => (k === "mock" ? flaky : getSourceAdapter(k)) });
    await expect(handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, withFlaky)).rejects.toThrow(/temporarily unavailable/);
    const { idempotencyKey } = await import("@gigpilot/db");
    expect(await db.select().from(idempotencyKey).where(eq(idempotencyKey.scope, "application.submit"))).toHaveLength(0);
    expect(await handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, withFlaky)).toMatchObject({ status: "submitted" });
    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app!.status).toBe("submitted");
  });

  it("an ambiguous marketplace submission is recorded, the owner is asked to verify, and it is never resubmitted", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, AUTOMATION_BRIEF);
    const applicationId = await approvedApplication(t, deps, oppId);
    const { getSourceAdapter } = await import("../../providers/src/sources");
    const mock = getSourceAdapter("mock")!;
    let calls = 0;
    const flaky = Object.create(mock) as typeof mock;
    flaky.submit = async () => {
      calls++;
      throw new ProviderError("freelancer", "ambiguous_submission", "bid request timed out after it was sent");
    };
    const withFlaky = testDeps({ queue: deps.queue, sources: (k) => (k === "mock" ? flaky : getSourceAdapter(k)) });
    expect(await handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, withFlaky)).toMatchObject({ status: "ambiguous" });
    expect(await handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, withFlaky)).toMatchObject({ status: "skipped" });
    expect(calls).toBe(1);
    const alerts = await db.select().from(notification).where(and(eq(notification.tenantId, t.tenantId), eq(notification.dedupeKey, `ambiguous-submit:${applicationId}`)));
    expect(alerts).toHaveLength(1);
    // The sweeper leaves it alone (a claim with an outcome exists).
    await db.update(application).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(application.id, applicationId));
    deps.queue.take("application-submit");
    await runOutboxSweep(deps);
    expect(deps.queue.take("application-submit")).toHaveLength(0);
  });

  it("requestProposal checks the opportunity state and never duplicates a live application", async () => {
    const t = await createTestTenant();
    const deps = testDeps();
    const oppId = await insertOpportunity(t, AUTOMATION_BRIEF);
    captureCommandQueue(deps.queue);
    await expect(requestProposal(t.ctx, oppId)).rejects.toThrow(/analysed, shortlisted or pursued/); // still `new`
    await approvedApplication(t, deps, oppId);
    await expect(requestProposal(t.ctx, oppId)).rejects.toThrow(/already has an application/);
  });

  // -------------------------------------------------------------------------
  // QA honesty, archive safety, output hygiene
  // -------------------------------------------------------------------------

  it("QA treats simulated test reports as unverified and never claims 'N tests passing' in the package", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, AUTOMATION_BRIEF, { plan: true });
    await drain(deps);
    const reviews = await db.select().from(qaReview).where(eq(qaReview.jobId, jobId));
    const findings = reviews.flatMap((r) => r.findings);
    expect(findings.some((f) => f.code === "tests_not_executed" && f.severity === "minor")).toBe(true);
    const passing = reviews.filter((r) => r.verdict === "pass");
    expect(passing.every((r) => !/\d+ tests passing/.test(r.summary))).toBe(true);
    const testStep = (await stepsOf(jobId)).find((s) => s.kind === "test")!;
    expect(testStep.output).toMatchObject({ testsExecuted: false });
    expect(String((testStep.output as Record<string, unknown>).markdown)).toMatch(/generated but not executed/);
    const [d] = await db.select().from(delivery).where(eq(delivery.jobId, jobId)).orderBy(desc(delivery.createdAt)).limit(1);
    const [pkg] = await db.select().from(asset).where(eq(asset.id, d!.packageAssetId!));
    const files = unzipSync(await getStorage().get(pkg!.storageKey));
    const qaMd = strFromU8(files["QA-SUMMARY.md"]!);
    const notes = strFromU8(files["DELIVERY-NOTES.md"]!);
    expect(qaMd).toMatch(/tests generated but not executed in this environment/);
    expect(qaMd).not.toMatch(/\d+ tests passing/);
    expect(notes).not.toMatch(/\d+ tests passing/);
  });

  it("rejects zip-slip paths in generated code archives", () => {
    expect(safeArchivePath("src/index.ts")).toBe("src/index.ts");
    expect(safeArchivePath("./src//a/./b.ts")).toBe("src/a/b.ts");
    for (const bad of ["../../etc/passwd", "/etc/passwd", "src/../../x", "C:\\\\Windows\\\\x", "..", "~/.ssh/id_rsa", "a/..", ""]) expect(safeArchivePath(bad)).toBeNull();
    const { bytes, rejected } = zipArtifact({
      summary: "x",
      files: [
        { path: "README.md", content: "# hi" },
        { path: "../../../../tmp/pwned.sh", content: "rm -rf /" },
        { path: "/abs/evil.ts", content: "x" },
        { path: "src/..\\..\\evil.ts", content: "x" },
      ],
      testReport: { runner: "vitest", simulated: true, passed: 0, failed: 0, tests: [] },
    });
    expect(rejected).toEqual(["../../../../tmp/pwned.sh", "/abs/evil.ts", "src/..\\..\\evil.ts"]);
    const names = Object.keys(unzipSync(bytes));
    expect(names.sort()).toEqual(["project/README.md", "project/test-report.json"]);
    expect(names.every((n) => n.startsWith("project/") && !n.includes(".."))).toBe(true);
  });

  it("discards model output that carries a likely secret and falls back to the deterministic result", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const leak = ["sk", "live", "Z9y8X7w6V5u4T3s2R1q0P9o8"].join("-");
    const deps = testDeps({ router: createIntelligenceRouter([new GatedIntelligence(leak), new MockIntelligenceProvider()]) });
    const res = await runAgent({ deps, tenantId: t.tenantId, agent: "researcher", task: "doc" }, (ctx) =>
      callIntelligence(ctx, {
        task: "summarise",
        messages: [{ role: "user", content: "Summarise <untrusted_brief>x</untrusted_brief>" }],
        mockResult: () => ({ markdown: "## Summary\nA deterministic summary." }),
      }),
    );
    expect(res.family).toBe("gx");
    expect(res.data).toBeUndefined();
    expect(res.text).toBe("");
    const events = await db.select().from(agentEvent).where(and(eq(agentEvent.tenantId, t.tenantId), eq(agentEvent.type, "security.output_rejected")));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(leak);
  });

  it("per-tenant daily heavy-GX quota falls back to triage/mock (cheap tasks unaffected) with one event", async () => {
    const db = getDb();
    const t = await createTestTenant({ settings: { limits: { dailyLocalModelCalls: 1 } } });
    const gx = new GatedIntelligence();
    const deps = testDeps({ router: createIntelligenceRouter([gx, new MockIntelligenceProvider()]) });
    const call = (task: "plan_production" | "triage") =>
      runAgent({ deps, tenantId: t.tenantId, agent: "planner", task: "quota" }, (ctx) => callIntelligence(ctx, { task, messages: [{ role: "user", content: "plan" }], mockResult: () => ({ ok: true }) }));
    expect((await call("plan_production")).family).toBe("gx");
    expect((await call("plan_production")).family).toBe("mock");
    expect((await call("plan_production")).family).toBe("mock");
    expect((await call("triage")).family).toBe("gx"); // cheap tasks use the fast model, not the shared heavy slot
    const events = await db.select().from(agentEvent).where(and(eq(agentEvent.tenantId, t.tenantId), eq(agentEvent.type, "provider.quota")));
    expect(events).toHaveLength(1);
  });

  it("the job monitor closes orphaned running generations", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    const jobId = await wonJob(t, deps, IMAGE_BRIEF, { plan: true });
    const { generation } = await import("@gigpilot/db");
    const [g] = await db
      .insert(generation)
      .values({ tenantId: t.tenantId, jobId, provider: "kie", model: "nano-banana-2", capability: "image.generate", status: "running", idempotencyKey: "orphan#1", unitKey: "orphan", updatedAt: new Date(Date.now() - 2 * 3_600_000) })
      .returning();
    const mon = (await handlers["job-monitor"]({}, deps)) as { orphanGenerations: number };
    expect(mon.orphanGenerations).toBe(1);
    const [after] = await db.select().from(generation).where(eq(generation.id, g!.id));
    expect(after).toMatchObject({ status: "failed" });
    expect(after!.error).toMatch(/orphaned/);
  });

  it("caps GX refinement per tenant per hour, refining the most profitable candidates first", async () => {
    const db = getDb();
    const t = await createTestTenant({ settings: { limits: { maxRefinesPerHour: 2 } } });
    const deps = testDeps();
    const ids: string[] = [];
    for (const [i, budget] of [4800, 4200, 3600, 3000].entries()) {
      ids.push(await insertOpportunity(t, { ...AUTOMATION_BRIEF, title: `${AUTOMATION_BRIEF.title} #${i + 1}`, budgetMinUsd: budget, budgetMaxUsd: budget }));
    }
    for (const id of ids) await handlers["opportunity-analyse"]({ tenantId: t.tenantId, opportunityId: id }, deps);
    const refineJobs = deps.queue.take("opportunity-refine");
    const refines = refineJobs.map((x) => (x.payload as { opportunityId: string }).opportunityId);
    const events = await db.select().from(agentEvent).where(and(eq(agentEvent.tenantId, t.tenantId), eq(agentEvent.type, "opportunity.analysed")));
    // Triage never recommends pursuit: candidates are stored as "consider" and flagged for refinement.
    expect(events.every((e) => (e.data as Record<string, unknown>).recommendation !== "pursue")).toBe(true);
    const pursue = events.filter((e) => (e.data as Record<string, unknown>).pursueCandidate === true);
    expect(pursue.length).toBe(4);
    expect(pursue.every((e) => (e.data as Record<string, unknown>).recommendation === "consider")).toBe(true);
    expect(refines).toHaveLength(2);
    expect(refines).toEqual(ids.slice(0, 2)); // the two highest-profit candidates
    // Refine jobs carry a priority = expected profit so the single heavy-model slot
    // refines the most valuable candidate first.
    const priorities = refineJobs.map((x) => Number((x.options as { priority?: number } | undefined)?.priority ?? 0));
    expect(priorities).toHaveLength(2);
    expect(priorities[0]).toBeGreaterThan(priorities[1]);
    const skipped = pursue.filter((e) => (e.data as Record<string, unknown>).refineSkipped === "hourly cap");
    expect(skipped.map((e) => e.subjectId).sort()).toEqual(ids.slice(2).sort());
  });

  // -------------------------------------------------------------------------
  // Dashboard commands
  // -------------------------------------------------------------------------

  it("ingestInboundOpportunity keeps the external id + message metadata, dedupes, and queues analysis", async () => {
    const db = getDb();
    const t = await createTestTenant();
    const deps = testDeps();
    captureCommandQueue(deps.queue);
    const raw = { sourceKey: "contra", externalId: "contra-123", title: "Landing page for a fintech waitlist", description: "We need a fast Next.js landing page with a waitlist form, analytics and a CMS for blog posts. Budget is fixed.", budgetType: "fixed" as const, budgetMinUsd: 1500, budgetMaxUsd: 2000 };
    const first = await ingestInboundOpportunity(t.tenantId, raw, "contra", { messageId: "<m1@mail>" });
    expect(first.duplicate).toBe(false);
    const [row] = await db.select().from(opportunity).where(eq(opportunity.id, first.opportunityId));
    expect(row).toMatchObject({ externalId: "contra-123", sourceKey: "contra", status: "new" });
    expect(row!.raw).toMatchObject({ ingestion: "email", inboundProvider: "contra", messageId: "<m1@mail>" });
    expect(deps.queue.take("opportunity-analyse").map((x) => (x.payload as { opportunityId: string }).opportunityId)).toEqual([first.opportunityId]);
    const again = await ingestInboundOpportunity(t.tenantId, raw, "contra", { messageId: "<m1@mail>" });
    expect(again).toEqual({ opportunityId: first.opportunityId, duplicate: true });
    const crossPost = await ingestInboundOpportunity(t.tenantId, { ...raw, externalId: "contra-999" }, "contra", { messageId: "<m2@mail>" });
    expect(crossPost).toEqual({ opportunityId: first.opportunityId, duplicate: true });
    expect(deps.queue.take("opportunity-analyse")).toHaveLength(0);
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.tenantId, t.tenantId), eq(auditEvent.action, "opportunity.ingested")));
    expect(audits.every((a) => a.actorType === "system")).toBe(true);
  });

  it("updateMarkets is all-or-nothing and recordIntegrationHealth upserts an audited status", async () => {
    const db = getDb();
    const t = await createTestTenant();
    await expect(
      updateMarkets(t.ctx, [
        { key: "ai-automation", allocationPct: 40 },
        { key: "does-not-exist", enabled: false },
      ]),
    ).rejects.toBeInstanceOf(CommandError);
    let [m] = await db.select().from(market).where(and(eq(market.tenantId, t.tenantId), eq(market.key, "ai-automation")));
    expect(m!.allocationPct).toBe(25); // rolled back
    await updateMarkets(t.ctx, [
      { key: "ai-automation", allocationPct: 40 },
      { key: "image-design", enabled: false, allocationPct: 0 },
    ]);
    [m] = await db.select().from(market).where(and(eq(market.tenantId, t.tenantId), eq(market.key, "ai-automation")));
    expect(m!.allocationPct).toBe(40);

    await recordIntegrationHealth(t.ctx, "gx", { status: "degraded", detail: "gx-code missing", latencyMs: 42, checkedAt: new Date().toISOString(), meta: { models: ["gx-mini"] } });
    const [p] = await db.select().from(providerIntegration).where(and(eq(providerIntegration.tenantId, t.tenantId), eq(providerIntegration.providerKey, "gx")));
    expect(p).toMatchObject({ status: "degraded", statusDetail: "gx-code missing", latencyMs: 42 });
    expect(p!.lastCheckAt).not.toBeNull();
    await expect(recordIntegrationHealth({ ...t.ctx, role: "member" }, "gx", { status: "connected", detail: "ok", checkedAt: "" })).rejects.toBeInstanceOf(CommandError);
    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.tenantId, t.tenantId), eq(auditEvent.action, "integration.health_recorded")));
    expect(audits).toHaveLength(1);
  });
});

describe("operator paid-spend ceiling (security H1)", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "0";
    process.env.TENANT_MAX_DAILY_PAID_USD = "0";
    resetEnvCache();
  });

  it("a non-operator workspace that saved a high paid limit still gets no paid budget without an operator grant", async () => {
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "50";
    process.env.TENANT_MAX_DAILY_PAID_USD = "0";
    resetEnvCache();
    const t = await createTestTenant({ settings: { limits: { dailyPaidSpendLimitUsd: 1_000_000 } } });
    const { computeBudget } = await import("./runtime");
    const { getTenantSettings } = await import("@gigpilot/db");
    const settings = await getTenantSettings(getDb(), t.tenantId);
    expect((await computeBudget(getDb(), t.tenantId, settings)).allowPaid).toBe(false);

    process.env.TENANT_MAX_DAILY_PAID_USD = "3";
    resetEnvCache();
    const granted = await computeBudget(getDb(), t.tenantId, settings);
    expect(granted.allowPaid).toBe(true);
    expect(granted.remainingPaidUsd).toBeLessThanOrEqual(3);
  });
});
