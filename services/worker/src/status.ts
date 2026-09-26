import { QUEUES, type QueueName } from "@gigpilot/contracts";
import { agentRun, and, application, count, delivery, desc, eq, getDb, gte, inArray, job, opportunity, pingDb, proposal, sql, workflowStep } from "@gigpilot/db";
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
  if (!boss) return out;
  try {
    const rows = await boss.getQueues(Object.values(QUEUES));
    for (const r of rows) out[r.name] = { queued: Number(r.queuedCount ?? 0), active: Number(r.activeCount ?? 0), failed: Number(r.failedCount ?? 0) };
  } catch {
    /* queue stats are best effort */
  }
  return out;
}

async function n(q: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await q;
  return Number(row?.n ?? 0);
}

export async function pendingCounts(now = new Date()): Promise<AgentOSStatusSnapshot["pending"]> {
  const db = getDb();
  const since = new Date(now.getTime() - 86_400_000);
  const [shortlisted, proposals, manual, prepared, activeJobs, awaitingFinal, failedSteps] = await Promise.all([
    n(db.select({ n: count() }).from(opportunity).where(eq(opportunity.status, "shortlisted"))),
    n(db.select({ n: count() }).from(proposal).where(eq(proposal.status, "awaiting_approval"))),
    n(db.select({ n: count() }).from(application).where(eq(application.status, "approved"))),
    n(db.select({ n: count() }).from(delivery).where(eq(delivery.status, "prepared"))),
    n(db.select({ n: count() }).from(job).where(inArray(job.status, ["intake", "planning", "awaiting_inputs", "ready", "executing", "qa", "repairing"]))),
    n(db.select({ n: count() }).from(job).where(eq(job.status, "awaiting_final_approval"))),
    n(db.select({ n: count() }).from(workflowStep).where(and(eq(workflowStep.status, "failed"), gte(workflowStep.updatedAt, since)))),
  ]);
  return { approvals: shortlisted + proposals + manual + prepared, activeJobs, awaitingFinalApproval: awaitingFinal, failedStepsLast24h: failedSteps };
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
  kind: "opportunity_approval" | "proposal_approval" | "manual_submission" | "final_delivery_approval" | "failed_step";
  tenantId: string;
  ageMinutes: number;
  summary: string;
}

const age = (d: Date, now: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));

export async function pendingItems(limit = 100): Promise<PendingItem[]> {
  const db = getDb();
  const now = new Date();
  const since = new Date(now.getTime() - 86_400_000);
  const [opps, props, apps, jobs, steps] = await Promise.all([
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
  ]);
  const items: PendingItem[] = [
    ...opps.map((o) => ({ id: o.id, kind: "opportunity_approval" as const, tenantId: o.tenantId, ageMinutes: age(o.at, now), summary: `Shortlisted ${o.market ?? "opportunity"} awaiting pursue decision (~$${Math.round(o.profit ?? 0)} expected profit)` })),
    ...props.map((p) => ({ id: p.id, kind: "proposal_approval" as const, tenantId: p.tenantId, ageMinutes: age(p.at, now), summary: `Proposal awaiting approval at $${Math.round(p.price)}` })),
    ...apps.map((a) => ({ id: a.id, kind: "manual_submission" as const, tenantId: a.tenantId, ageMinutes: age(a.at, now), summary: `Approved application awaiting submission ($${Math.round(a.price ?? 0)})` })),
    ...jobs.map((j) => ({ id: j.id, kind: "final_delivery_approval" as const, tenantId: j.tenantId, ageMinutes: age(j.at, now), summary: `${j.family} delivery package awaiting final approval` })),
    ...steps.map((s) => ({ id: s.id, kind: "failed_step" as const, tenantId: s.tenantId, ageMinutes: age(s.at, now), summary: `${s.kind} step failed (${s.attempts}/${s.max} attempts)` })),
  ];
  return items.sort((a, b) => b.ageMinutes - a.ageMinutes).slice(0, limit);
}

export async function migrationsApplied(): Promise<boolean> {
  try {
    const rows = (await getDb().execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export type { QueueName };
