import { QUEUES, type QueuePayloads } from "@gigpilot/contracts";
import { and, asc, delivery, emitEvent, eq, getDb, inArray, job, revision, transition, workflow, workflowStep } from "@gigpilot/db";
import type { AgentDeps } from "../deps";
import { isQaStep } from "../heuristics/workflows";
import { notify } from "../lib/notify";
import { quote } from "../lib/util";
import type { StepRow } from "../runtime";
import { handleRevisionRequest } from "./recovery";

/** Max steps of one job executing concurrently. */
export const JOB_PARALLELISM = 2;

const ACTIVE_JOB_STATES = ["ready", "executing", "qa", "repairing"] as const;

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
  deliveryQueued: boolean;
}

/**
 * Orchestrator tick (stately per job). Advances the DAG: promotes steps whose
 * dependencies succeeded, retries failed steps within their attempt limit
 * (each retry is a new agent_run), moves the job into QA when the QA step is
 * reached, dispatches ready steps up to the per-job parallelism cap and
 * queues delivery packaging once every step has succeeded. Every status
 * change goes through transition().
 */
export async function runWorkflowTick(payload: QueuePayloads["workflow-tick"], deps: AgentDeps): Promise<TickResult> {
  const db = getDb();
  const { tenantId, jobId } = payload;
  const result: TickResult = { status: "ticked", dispatched: [], readied: [], retried: [], deliveryQueued: false };
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

  // Owner-requested changes: reopen work before anything else.
  if (jobStatus === "repairing") {
    const [openRevision] = await db
      .select()
      .from(revision)
      .where(and(eq(revision.jobId, j.id), eq(revision.status, "open")))
      .limit(1);
    if (openRevision && steps.every((s) => s.status === "succeeded" || s.status === "skipped")) {
      await handleRevisionRequest({ tenantId, job: j, revisionRow: openRevision, steps }, deps);
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
    } else if (s.status === "blocked" && depsDone(s) && (s.output as Record<string, unknown> | null)?.blockedReason !== "budget") {
      await transition(db, { machine: "step", id: s.id, tenantId, to: "ready", actor, reason: "upstream repaired" });
      s.status = "ready";
      result.readied.push(s.key);
    } else if (s.status === "failed") {
      const qaVerdictFail = isQaStep(s) && (s.output as Record<string, unknown> | null)?.verdict === "fail";
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
        await notify(db, {
          tenantId,
          kind: "alert",
          title: `${s.name} failed ${s.attempts} times`,
          body: `“${j.title.slice(0, 80)}” is paused: ${s.error ?? "step failed"}. Review and retry or adjust limits.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `step-exhausted:${s.id}`,
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
      .where(and(eq(delivery.jobId, j.id), inArray(delivery.status, ["preparing", "prepared"])))
      .limit(1);
    if (!pending[0]) {
      await deps.queue.send(QUEUES.deliveryPrepare, { tenantId, jobId: j.id }, { singletonKey: j.id });
      result.deliveryQueued = true;
      await emitEvent(db, { tenantId, type: "job.state", level: "info", agent: "orchestrator", subjectType: "job", subjectId: j.id, jobId: j.id, message: `All ${steps.length} steps of ${quote(j.title)} succeeded — packaging delivery` });
    }
  }
  return result;
}
