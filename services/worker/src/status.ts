import { OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import { QUEUES, type QueueName } from "@gigpilot/contracts";
import {
  agentRun,
  and,
  application,
  count,
  delivery,
  desc,
  eq,
  getDb,
  gte,
  inArray,
  job,
  lt,
  migrationStatus,
  opportunity,
  or,
  pingDb,
  proposal,
  sql,
  workflowStep,
  type Executor,
} from "@gigpilot/db";
import type { AgentOSStatusSnapshot } from "@gigpilot/providers";

/**
 * Supervision data for AgentOS (pull-only). Counts and ids only — no titles,
 * client names, secrets or chain-of-thought.
 */

export interface QueueStatsSource {
  getQueues(names?: string[]): Promise<{ name: string; queuedCount: number; activeCount: number; failedCount: number }[]>;
}

export interface ErrorRing {
  push(message: string): void;
  list(): { at: string; message: string }[];
}

export function createErrorRing(size = 20): ErrorRing {
  const items: { at: string; message: string }[] = [];
  return {
    push(message) {
      items.unshift({ at: new Date().toISOString(), message: message.slice(0, 300) });
      if (items.length > size) items.length = size;
    },
    list: () => [...items],
  };
}

export const WORKER_VERSION = process.env.GIGPILOT_VERSION ?? "0.1.0";

async function queueStats(boss: QueueStatsSource | null): Promise<AgentOSStatusSnapshot["queues"]> {
  const out: AgentOSStatusSnapshot["queues"] = {};
  for (const name of Object.values(QUEUES)) out[name] = { queued: 0, active: 0, failed: 0 };
  if (!boss) return out;
  try {
    // Live counts straight from pg-boss's job table (getQueues() returns periodically cached counts).
    const rows = (await getDb().execute(
      sql`select name, state, count(*)::int as n from pgboss.job where state in ('created', 'retry', 'active', 'failed') group by name, state`,
    )) as unknown as { name: string; state: string; n: number }[];
    for (const r of rows) {
      const q = out[r.name] ?? (out[r.name] = { queued: 0, active: 0, failed: 0 });
      if (r.state === "created" || r.state === "retry") q.queued += Number(r.n);
      else if (r.state === "active") q.active += Number(r.n);
      else if (r.state === "failed") q.failed += Number(r.n);
    }
  } catch {
    /* queue stats are best effort */
  }
  return out;
}

const ACTIVE = ["ready", "executing", "qa", "repairing"] as const;
/** Steps parked for the owner (see packages/agents lib/steps OWNER_BLOCK_REASONS). */
const OWNER_BLOCKED_SQL = sql`coalesce(${workflowStep.output} ->> 'blockedReason', '') in ('budget', 'ambiguous_submission', 'attempts_exhausted', 'repair_limit')`;

async function n(q: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await q;
  return Number(row?.n ?? 0);
}

export async function pendingCounts(now = new Date()): Promise<AgentOSStatusSnapshot["pending"]> {
  const db = getDb();
  const since = new Date(now.getTime() - 86_400_000);
  const [shortlisted, proposals, manual, prepared, activeJobs, awaitingFinal, failedSteps, awaitingInputs, blockedSteps, failedDeliveries] = await Promise.all([
    n(db.select({ n: count() }).from(opportunity).where(eq(opportunity.status, "shortlisted"))),
    n(db.select({ n: count() }).from(proposal).where(eq(proposal.status, "awaiting_approval"))),
    n(db.select({ n: count() }).from(application).where(eq(application.status, "approved"))),
    n(db.select({ n: count() }).from(delivery).where(eq(delivery.status, "prepared"))),
    n(db.select({ n: count() }).from(job).where(inArray(job.status, ["intake", "planning", "awaiting_inputs", "ready", "executing", "qa", "repairing"]))),
    n(db.select({ n: count() }).from(job).where(eq(job.status, "awaiting_final_approval"))),
    n(db.select({ n: count() }).from(workflowStep).where(and(eq(workflowStep.status, "failed"), gte(workflowStep.updatedAt, since)))),
    n(db.select({ n: count() }).from(job).where(eq(job.status, "awaiting_inputs"))),
    n(db.select({ n: count() }).from(workflowStep).innerJoin(job, eq(job.id, workflowStep.jobId)).where(and(eq(workflowStep.status, "blocked"), OWNER_BLOCKED_SQL, inArray(job.status, ACTIVE)))),
    n(db.select({ n: count() }).from(delivery).where(eq(delivery.status, "failed"))),
  ]);
  // Everything waiting on a human counts as an approval-type item for AgentOS.
  return {
    approvals: shortlisted + proposals + manual + prepared + awaitingInputs + blockedSteps + failedDeliveries,
    activeJobs,
    awaitingFinalApproval: awaitingFinal,
    failedStepsLast24h: failedSteps,
  };
}

export async function buildSnapshot(boss: QueueStatsSource | null, errors: ErrorRing, opts: { bossStarted: boolean }): Promise<AgentOSStatusSnapshot> {
  const now = new Date();
  const ping = await pingDb();
  const queues = await queueStats(boss);
  let pending: AgentOSStatusSnapshot["pending"] = { approvals: 0, activeJobs: 0, awaitingFinalApproval: 0, failedStepsLast24h: 0 };
  let recentFailures: { at: string; message: string }[] = [];
  if (ping.ok) {
    pending = await pendingCounts(now);
    const runs = await getDb()
      .select({ at: agentRun.finishedAt, agent: agentRun.agent, task: agentRun.task, error: agentRun.error })
      .from(agentRun)
      .where(and(eq(agentRun.status, "failed"), gte(agentRun.createdAt, new Date(now.getTime() - 86_400_000))))
      .orderBy(desc(agentRun.createdAt))
      .limit(10);
    recentFailures = runs.map((r) => ({ at: (r.at ?? now).toISOString(), message: `${r.agent}/${r.task}: ${(r.error ?? "failed").slice(0, 200)}` }));
  }
  const failedQueueJobs = Object.values(queues).reduce((a, q) => a + q.failed, 0);
  const health: AgentOSStatusSnapshot["health"] = !ping.ok || !opts.bossStarted ? "down" : pending.failedStepsLast24h > 10 || failedQueueJobs > 50 ? "degraded" : "ok";
  const lastErrors = [...errors.list(), ...recentFailures].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
  return { service: "gigpilot", version: WORKER_VERSION, generatedAt: now.toISOString(), health, queues, pending, lastErrors };
}

export interface PendingItem {
  id: string;
  kind:
    | "opportunity_approval"
    | "proposal_approval"
    | "manual_submission"
    | "final_delivery_approval"
    | "failed_step"
    | "awaiting_inputs"
    | "blocked_step"
    | "repair_limit"
    | "delivery_failed"
    | "delivery_stuck";
  tenantId: string;
  ageMinutes: number;
  summary: string;
}

const age = (d: Date, now: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));

const BLOCK_LABEL: Record<string, string> = {
  budget: "blocked by the job spend limit (raise it to continue)",
  ambiguous_submission: "paused: provider may have accepted the request — owner must verify before retrying",
  attempts_exhausted: "used all attempts — owner must resume",
};

/** Items waiting on a human (ids, kinds and counts only — no titles, client names or secrets). */
export async function pendingItems(limit = 100): Promise<PendingItem[]> {
  const db = getDb();
  const now = new Date();
  const since = new Date(now.getTime() - 86_400_000);
  const stalePreparing = new Date(now.getTime() - OPERATIONAL_DEFAULTS.stalePreparingDeliveryMinutes * 60_000);
  const [opps, props, apps, jobs, steps, waiting, blocked, deliveries] = await Promise.all([
    db.select({ id: opportunity.id, tenantId: opportunity.tenantId, at: opportunity.updatedAt, profit: opportunity.expectedProfitUsd, market: opportunity.marketKey }).from(opportunity).where(eq(opportunity.status, "shortlisted")).orderBy(desc(opportunity.updatedAt)).limit(limit),
    db.select({ id: proposal.id, tenantId: proposal.tenantId, at: proposal.updatedAt, price: proposal.priceUsd }).from(proposal).where(eq(proposal.status, "awaiting_approval")).orderBy(desc(proposal.updatedAt)).limit(limit),
    db.select({ id: application.id, tenantId: application.tenantId, at: application.updatedAt, price: application.priceUsd }).from(application).where(eq(application.status, "approved")).orderBy(desc(application.updatedAt)).limit(limit),
    db.select({ id: job.id, tenantId: job.tenantId, at: job.updatedAt, family: job.serviceFamily }).from(job).where(eq(job.status, "awaiting_final_approval")).orderBy(desc(job.updatedAt)).limit(limit),
    db
      .select({ id: workflowStep.id, tenantId: workflowStep.tenantId, at: workflowStep.updatedAt, kind: workflowStep.kind, attempts: workflowStep.attempts, max: workflowStep.maxAttempts })
      .from(workflowStep)
      .where(and(eq(workflowStep.status, "failed"), gte(workflowStep.updatedAt, since)))
      .orderBy(desc(workflowStep.updatedAt))
      .limit(limit),
    db.select({ id: job.id, tenantId: job.tenantId, at: job.updatedAt, family: job.serviceFamily }).from(job).where(eq(job.status, "awaiting_inputs")).orderBy(desc(job.updatedAt)).limit(limit),
    db
      .select({ id: workflowStep.id, tenantId: workflowStep.tenantId, at: workflowStep.updatedAt, kind: workflowStep.kind, reason: sql<string>`${workflowStep.output} ->> 'blockedReason'`, attempts: workflowStep.attempts, max: workflowStep.maxAttempts })
      .from(workflowStep)
      .innerJoin(job, eq(job.id, workflowStep.jobId))
      .where(and(eq(workflowStep.status, "blocked"), OWNER_BLOCKED_SQL, inArray(job.status, ACTIVE)))
      .orderBy(desc(workflowStep.updatedAt))
      .limit(limit),
    db
      .select({ id: delivery.id, tenantId: delivery.tenantId, at: delivery.updatedAt, status: delivery.status, attempts: delivery.attempts })
      .from(delivery)
      .where(or(eq(delivery.status, "failed"), and(eq(delivery.status, "preparing"), lt(delivery.updatedAt, stalePreparing))))
      .orderBy(desc(delivery.updatedAt))
      .limit(limit),
  ]);
  const items: PendingItem[] = [
    ...opps.map((o) => ({ id: o.id, kind: "opportunity_approval" as const, tenantId: o.tenantId, ageMinutes: age(o.at, now), summary: `Shortlisted ${o.market ?? "opportunity"} awaiting pursue decision (~$${Math.round(o.profit ?? 0)} expected profit)` })),
    ...props.map((p) => ({ id: p.id, kind: "proposal_approval" as const, tenantId: p.tenantId, ageMinutes: age(p.at, now), summary: `Proposal awaiting approval at $${Math.round(p.price)}` })),
    ...apps.map((a) => ({ id: a.id, kind: "manual_submission" as const, tenantId: a.tenantId, ageMinutes: age(a.at, now), summary: `Approved application awaiting submission ($${Math.round(a.price ?? 0)})` })),
    ...jobs.map((j) => ({ id: j.id, kind: "final_delivery_approval" as const, tenantId: j.tenantId, ageMinutes: age(j.at, now), summary: `${j.family} delivery package awaiting final approval` })),
    ...steps.map((s) => ({ id: s.id, kind: "failed_step" as const, tenantId: s.tenantId, ageMinutes: age(s.at, now), summary: `${s.kind} step failed (${s.attempts}/${s.max} attempts)` })),
    ...waiting.map((j) => ({ id: j.id, kind: "awaiting_inputs" as const, tenantId: j.tenantId, ageMinutes: age(j.at, now), summary: `${j.family} job waiting for client inputs (owner confirms)` })),
    ...blocked.map((s) =>
      s.reason === "repair_limit"
        ? { id: s.id, kind: "repair_limit" as const, tenantId: s.tenantId, ageMinutes: age(s.at, now), summary: "QA failed and automatic repairs are exhausted — owner must resume or revise" }
        : { id: s.id, kind: "blocked_step" as const, tenantId: s.tenantId, ageMinutes: age(s.at, now), summary: `${s.kind} step ${BLOCK_LABEL[s.reason] ?? "blocked"} (${s.attempts}/${s.max} attempts)` },
    ),
    ...deliveries.map((d) =>
      d.status === "failed"
        ? { id: d.id, kind: "delivery_failed" as const, tenantId: d.tenantId, ageMinutes: age(d.at, now), summary: `Delivery packaging failed (${d.attempts} attempt${d.attempts === 1 ? "" : "s"})` }
        : { id: d.id, kind: "delivery_stuck" as const, tenantId: d.tenantId, ageMinutes: age(d.at, now), summary: `Delivery packaging in progress for over ${OPERATIONAL_DEFAULTS.stalePreparingDeliveryMinutes} min` },
    ),
  ];
  return items.sort((a, b) => b.ageMinutes - a.ageMinutes).slice(0, limit);
}

/** Database schema matches the migrations bundled with this build (count + latest journal entry). */
export async function migrationState(db: Executor = getDb()): Promise<{ ok: boolean; detail: string }> {
  const st = await migrationStatus(db);
  return { ok: st.ok, detail: st.detail };
}

/** @deprecated use migrationState (kept for callers that only need a boolean). */
export async function migrationsApplied(): Promise<boolean> {
  return (await migrationState()).ok;
}

/** Cheap live query against pg-boss's own schema (fails if the queue tables are unreachable). */
export async function queueHealthy(db: Executor = getDb()): Promise<boolean> {
  try {
    await db.execute(sql`select 1 from pgboss.queue limit 1`);
    return true;
  } catch {
    return false;
  }
}

export type { QueueName };
