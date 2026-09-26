import { OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import { QUEUES, type QueuePayloads } from "@gigpilot/contracts";
import { and, asc, delivery, emitEvent, eq, getDb, inArray, job, revision, transition, workflow, workflowStep } from "@gigpilot/db";
import type { AgentDeps } from "../deps";
import { isQaStep } from "../heuristics/workflows";
import { notify } from "../lib/notify";
import { quote } from "../lib/util";
import type { StepRow } from "../runtime";
import { blockedReasonOf, isOwnerBlocked } from "../lib/steps";
import { handleRevisionRequest, recoverFromQaFailure } from "./recovery";

/** Max steps of one job executing concurrently (OPERATIONAL_DEFAULTS.jobParallelism, see DECISIONS D12). */
export const JOB_PARALLELISM = OPERATIONAL_DEFAULTS.jobParallelism;

const ACTIVE_JOB_STATES = ["ready", "executing", "qa", "repairing"] as const;

/** Delivery rows that mean "packaging is in progress or needs the job monitor" (never queue another). */
export const OPEN_DELIVERY_STATES = ["preparing", "prepared", "failed"] as const;

export async function loadActiveSteps(tenantId: string, jobId: string): Promise<StepRow[]> {
  const db = getDb();
  const [wf] = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(and(eq(workflow.jobId, jobId), eq(workflow.tenantId, tenantId), eq(workflow.status, "active")))
    .limit(1);
  if (!wf) return [];
  return db.select().from(workflowStep).where(eq(workflowStep.workflowId, wf.id)).orderBy(asc(workflowStep.position));
}

export interface TickResult {
  status: "skipped" | "ticked";
  reason?: string;
  dispatched: string[];
  readied: string[];
  retried: string[];
  blocked: string[];
  deliveryQueued: boolean;
}

function outputOf(s: StepRow): Record<string, unknown> {
  return (s.output ?? {}) as Record<string, unknown>;
}

/**
 * Orchestrator tick (stately per job). Advances the DAG: promotes steps whose
 * dependencies succeeded, retries failed steps within their attempt limit
 * (each retry is a new agent_run), parks steps that exhausted their attempts
 * as `blocked` for the owner (resumeJob), processes owner revisions, re-runs
 * Recovery after an owner resume, moves the job into QA when the QA step is
 * reached, dispatches ready steps up to the per-job parallelism cap and
 * queues delivery packaging once every step has succeeded. Every status
 * change goes through transition().
 */
export async function runWorkflowTick(payload: QueuePayloads["workflow-tick"], deps: AgentDeps): Promise<TickResult> {
  const db = getDb();
  const { tenantId, jobId } = payload;
  const result: TickResult = { status: "ticked", dispatched: [], readied: [], retried: [], blocked: [], deliveryQueued: false };
  const [j] = await db.select().from(job).where(and(eq(job.id, jobId), eq(job.tenantId, tenantId))).limit(1);
  if (!j) return { ...result, status: "skipped", reason: "job not found" };
  if (!(ACTIVE_JOB_STATES as readonly string[]).includes(j.status)) return { ...result, status: "skipped", reason: `job is ${j.status}` };
  const actor = { type: "agent" as const, id: "orchestrator" };

  let jobStatus = j.status;
  if (jobStatus === "ready") {
    await transition(db, {
      machine: "job",
      id: j.id,
      tenantId,
      to: "executing",
      actor,
      patch: { startedAt: new Date() },
      event: { type: "job.state", level: "info", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `Production started on ${quote(j.title)}` },
    });
    jobStatus = "executing";
  }

  let steps = await loadActiveSteps(tenantId, jobId);
  if (steps.length === 0) return { ...result, status: "skipped", reason: "no active workflow" };

  if (jobStatus === "repairing") {
    // Owner-requested changes: reopen work before anything else, whatever the step states.
    const [openRevision] = await db
      .select()
      .from(revision)
      .where(and(eq(revision.jobId, j.id), eq(revision.status, "open")))
      .limit(1);
    if (openRevision) {
      await handleRevisionRequest({ tenantId, job: j, revisionRow: openRevision, steps }, deps);
      steps = await loadActiveSteps(tenantId, jobId);
    }
    // Owner resumed a job that hit the repair limit: re-run Recovery on the failed QA review.
    const resumedQa = steps.find((s) => isQaStep(s) && s.status === "blocked" && blockedReasonOf(s) === "repair_limit" && outputOf(s).resumeRequestedAt);
    if (resumedQa) {
      const { resumeRequestedAt: _drop, ...rest } = outputOf(resumedQa);
      await db.update(workflowStep).set({ output: rest }).where(eq(workflowStep.id, resumedQa.id));
      await recoverFromQaFailure({ tenantId, jobId, qaStepId: resumedQa.id, parentRunId: null }, deps);
      steps = await loadActiveSteps(tenantId, jobId);
    }
  }

  const byKey = new Map(steps.map((s) => [s.key, s]));
  const depsDone = (s: StepRow) => s.dependsOn.every((d) => byKey.get(d)?.status === "succeeded" || byKey.get(d)?.status === "skipped");

  for (const s of steps) {
    if (s.status === "pending" && depsDone(s)) {
      await transition(db, { machine: "step", id: s.id, tenantId, to: "ready", actor, reason: "dependencies satisfied" });
      s.status = "ready";
      result.readied.push(s.key);
    } else if (s.status === "blocked" && depsDone(s) && !isOwnerBlocked(s)) {
      await transition(db, { machine: "step", id: s.id, tenantId, to: "ready", actor, reason: "upstream repaired" });
      s.status = "ready";
      result.readied.push(s.key);
    } else if (s.status === "failed") {
      const qaVerdictFail = isQaStep(s) && outputOf(s).verdict === "fail";
      if (qaVerdictFail) continue; // handled by the Recovery agent
      if (s.attempts < s.maxAttempts) {
        await transition(db, {
          machine: "step",
          id: s.id,
          tenantId,
          to: "ready",
          actor,
          reason: `retry ${s.attempts + 1}/${s.maxAttempts}`,
          event: { type: "step.started", level: "warn", agent: "orchestrator", subjectType: "step", subjectId: s.id, jobId: j.id, message: `Retrying ${s.name} (attempt ${s.attempts + 1} of ${s.maxAttempts})` },
        });
        s.status = "ready";
        result.retried.push(s.key);
      } else {
        // Attempts exhausted: park for the owner (resumeJob authorises a new attempt window).
        await transition(db, {
          machine: "step",
          id: s.id,
          tenantId,
          to: "blocked",
          actor,
          reason: `attempt limit reached (${s.attempts}/${s.maxAttempts}) — waiting for the owner`,
          patch: { output: { ...outputOf(s), blockedReason: "attempts_exhausted", blockedAt: new Date().toISOString() } },
          event: { type: "step.blocked", level: "warn", agent: "orchestrator", subjectType: "step", subjectId: s.id, jobId: j.id, message: `${s.name} used all ${s.maxAttempts} attempts — paused until you resume the job` },
        });
        s.status = "blocked";
        result.blocked.push(s.key);
        await notify(db, {
          tenantId,
          kind: "alert",
          title: `${s.name} failed ${s.attempts} times`,
          body: `“${j.title.slice(0, 80)}” is paused: ${s.error ?? "step failed"}. Review, then resume the job to authorise more attempts.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `step-exhausted:${s.id}:${s.maxAttempts}`,
        });
      }
    }
  }

  const qaStepReady = steps.some((s) => isQaStep(s) && s.status === "ready" && depsDone(s));
  if (qaStepReady && (jobStatus === "executing" || jobStatus === "repairing")) {
    await transition(db, {
      machine: "job",
      id: j.id,
      tenantId,
      to: "qa",
      actor,
      reason: "production complete — independent QA",
      event: { type: "job.state", level: "info", agent: "qa", subjectType: "job", subjectId: j.id, jobId: j.id, message: `${quote(j.title)} moved to independent QA` },
    });
    jobStatus = "qa";
  }

  const running = steps.filter((s) => s.status === "running").length;
  const slots = Math.max(0, JOB_PARALLELISM - running);
  const ready = steps.filter((s) => s.status === "ready" && depsDone(s)).slice(0, slots);
  for (const s of ready) {
    const attempt = s.attempts + 1;
    await deps.queue.send(QUEUES.stepExecute, { tenantId, jobId: j.id, stepId: s.id, attempt }, { singletonKey: `${s.id}:${attempt}` });
    result.dispatched.push(s.key);
  }

  if (steps.every((s) => s.status === "succeeded" || s.status === "skipped")) {
    const pending = await db
      .select({ id: delivery.id })
      .from(delivery)
      .where(and(eq(delivery.jobId, j.id), inArray(delivery.status, [...OPEN_DELIVERY_STATES])))
      .limit(1);
    if (!pending[0]) {
      await deps.queue.send(QUEUES.deliveryPrepare, { tenantId, jobId: j.id }, { singletonKey: j.id });
      result.deliveryQueued = true;
      await emitEvent(db, { tenantId, type: "job.state", level: "info", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `All ${steps.length} steps of ${quote(j.title)} succeeded — packaging delivery` });
    }
  }
  return result;
}
