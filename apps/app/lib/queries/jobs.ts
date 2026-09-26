import "server-only";
import { jobBlockers } from "@gigpilot/agents";
import { JOB_STATES, type JobState } from "@gigpilot/contracts";
import {
  agentRun,
  and,
  application,
  asc,
  asset,
  client,
  costLedgerEntry,
  delivery,
  desc,
  eq,
  getDb,
  getTenantSettings,
  job,
  opportunity,
  qaReview,
  repair,
  revision,
  sql,
  workflow,
  workflowStep,
} from "@gigpilot/db";
import type { JobBlockerView } from "../job-blockers";
import { listRecentEvents } from "./events";

export interface JobRow {
  id: string;
  title: string;
  status: JobState;
  serviceFamily: string;
  clientName: string | null;
  priceUsd: number;
  spendLimitUsd: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  repairCount: number;
  dueAt: Date | null;
  updatedAt: Date;
  done: number;
  total: number;
  running: number;
  sourceKey: string | null;
  /** Steps parked until the owner acts (budget / attempts exhausted / repair limit / ambiguous outcome). */
  ownerBlocked: number;
  /** Distinct owner-block reasons of those steps. */
  blockReasons: string[];
}

/** Step `output.blockedReason`s that wait for the owner (mirrors OWNER_BLOCK_REASONS in @gigpilot/agents). */
export const OWNER_BLOCK_REASONS_SQL = sql`('budget','ambiguous_submission','attempts_exhausted','repair_limit')`;

export async function listJobs(tenantId: string) {
  const db = getDb();
  const rows = (await db.execute(sql`
    select j.id, j.title, j.status, j.service_family, c.name as client_name, j.price_usd::float8 as price, j.spend_limit_usd::float8 as lim,
      j.estimated_cost_usd::float8 as est, j.actual_cost_usd::float8 as act, j.repair_count, j.due_at, j.updated_at, o.source_key,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status in ('succeeded','skipped'))::int as done,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status <> 'cancelled')::int as total,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status = 'running')::int as running,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status = 'blocked' and s.output->>'blockedReason' in ${OWNER_BLOCK_REASONS_SQL})::int as owner_blocked,
      (select string_agg(distinct s.output->>'blockedReason', ',') from workflow_step s where s.job_id = j.id and s.status = 'blocked' and s.output->>'blockedReason' in ${OWNER_BLOCK_REASONS_SQL}) as block_reasons
    from job j left join client c on c.id = j.client_id left join opportunity o on o.id = j.opportunity_id
    where j.tenant_id = ${tenantId}
    order by case j.status when 'awaiting_final_approval' then 0 when 'repairing' then 1 when 'executing' then 2 when 'qa' then 3 when 'planning' then 4 when 'intake' then 5 when 'awaiting_inputs' then 6 when 'ready' then 7 when 'delivered' then 8 else 9 end, j.updated_at desc
    limit 300
  `)) as unknown as Record<string, unknown>[];
  const jobs: JobRow[] = rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    status: r.status as JobState,
    serviceFamily: String(r.service_family),
    clientName: (r.client_name as string | null) ?? null,
    priceUsd: Number(r.price),
    spendLimitUsd: Number(r.lim),
    estimatedCostUsd: Number(r.est),
    actualCostUsd: Number(r.act),
    repairCount: Number(r.repair_count),
    dueAt: r.due_at ? new Date(r.due_at as string) : null,
    updatedAt: new Date(r.updated_at as string),
    done: Number(r.done),
    total: Number(r.total),
    running: Number(r.running),
    sourceKey: (r.source_key as string | null) ?? null,
    ownerBlocked: Number(r.owner_blocked ?? 0),
    blockReasons: r.block_reasons ? String(r.block_reasons).split(",").filter(Boolean) : [],
  }));
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  for (const j of jobs) counts[j.status] += 1;
  return { jobs, counts };
}

export type JobDetail = NonNullable<Awaited<ReturnType<typeof getJobDetail>>>;

export async function getJobDetail(tenantId: string, id: string) {
  const db = getDb();
  const [j] = await db
    .select()
    .from(job)
    .where(and(eq(job.id, id), eq(job.tenantId, tenantId)))
    .limit(1);
  if (!j) return null;
  const [clientRows, oppRows, appRows, wfRows, qas, repairs, revisions, assets, deliveries, ledger, runs, settings] = await Promise.all([
    j.clientId ? db.select().from(client).where(eq(client.id, j.clientId)).limit(1) : Promise.resolve([]),
    j.opportunityId ? db.select({ id: opportunity.id, title: opportunity.title, sourceKey: opportunity.sourceKey, url: opportunity.url }).from(opportunity).where(eq(opportunity.id, j.opportunityId)).limit(1) : Promise.resolve([]),
    j.applicationId ? db.select({ id: application.id, submissionMode: application.submissionMode, externalRef: application.externalRef }).from(application).where(eq(application.id, j.applicationId)).limit(1) : Promise.resolve([]),
    db.select().from(workflow).where(and(eq(workflow.jobId, id), eq(workflow.tenantId, tenantId))).orderBy(desc(workflow.version), desc(workflow.createdAt)).limit(1),
    db.select().from(qaReview).where(and(eq(qaReview.jobId, id), eq(qaReview.tenantId, tenantId))).orderBy(desc(qaReview.createdAt)),
    db.select().from(repair).where(and(eq(repair.jobId, id), eq(repair.tenantId, tenantId))).orderBy(desc(repair.createdAt)),
    db.select().from(revision).where(and(eq(revision.jobId, id), eq(revision.tenantId, tenantId))).orderBy(desc(revision.createdAt)),
    db.select().from(asset).where(and(eq(asset.jobId, id), eq(asset.tenantId, tenantId))).orderBy(asc(asset.createdAt)),
    db.select().from(delivery).where(and(eq(delivery.jobId, id), eq(delivery.tenantId, tenantId))).orderBy(desc(delivery.createdAt)).limit(1),
    db
      .select({ category: costLedgerEntry.category, kind: costLedgerEntry.kind, paid: costLedgerEntry.paid, total: sql<number>`sum(${costLedgerEntry.amountUsd})::float8` })
      .from(costLedgerEntry)
      .where(and(eq(costLedgerEntry.jobId, id), eq(costLedgerEntry.tenantId, tenantId)))
      .groupBy(costLedgerEntry.category, costLedgerEntry.kind, costLedgerEntry.paid),
    db.select().from(agentRun).where(and(eq(agentRun.jobId, id), eq(agentRun.tenantId, tenantId))).orderBy(desc(agentRun.createdAt)).limit(60),
    getTenantSettings(db, tenantId),
  ]);
  const wf = wfRows[0] ?? null;
  const steps = wf ? await db.select().from(workflowStep).where(and(eq(workflowStep.workflowId, wf.id), eq(workflowStep.tenantId, tenantId))).orderBy(asc(workflowStep.position)) : [];
  const events = await listRecentEvents(tenantId, { jobId: id, limit: 40 });
  return {
    job: j,
    client: clientRows[0] ?? null,
    opportunity: oppRows[0] ?? null,
    application: appRows[0] ?? null,
    workflow: wf,
    steps,
    qas,
    repairs,
    revisions,
    assets,
    delivery: deliveries[0] ?? null,
    ledger,
    runs,
    events,
    settings,
  };
}

/** Owner-facing blockers for a job (wraps the agents' `jobBlockers`) as a serializable view. */
export async function getJobBlockers(tenantId: string, jobId: string): Promise<JobBlockerView> {
  const b = await jobBlockers(tenantId, jobId);
  return {
    awaitingInputs: b.awaitingInputs,
    canConfirmInputs: b.canConfirmInputs,
    missingInputs: b.missingInputs.slice(0, 12).map((m) => String(m).slice(0, 200)),
    blockedSteps: b.blockedSteps.slice(0, 20).map((s) => ({ key: s.key, name: s.name, reason: s.reason, attempts: s.attempts, maxAttempts: s.maxAttempts })),
    repairLimitReached: b.repairLimitReached,
    budgetBlocked: b.budgetBlocked,
    deliveryFailed: b.deliveryFailed,
    canResume: b.canResume,
    canRequestRevision: b.canRequestRevision,
    spendCeilingUsd: b.spend.ceilingUsd,
  };
}
