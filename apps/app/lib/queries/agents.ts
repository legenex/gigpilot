import "server-only";
import { RUN_STATES, type RunState } from "@gigpilot/contracts";
import { agentEvent, agentRun, and, desc, eq, getDb, job, sql } from "@gigpilot/db";

type SQL = ReturnType<typeof eq>;

export async function getAgentRuns(tenantId: string, f: { agent?: string; state?: RunState; jobId?: string }) {
  const db = getDb();
  const le = db
    .select({ message: agentEvent.message, type: agentEvent.type, createdAt: agentEvent.createdAt })
    .from(agentEvent)
    .where(eq(agentEvent.runId, agentRun.id))
    .orderBy(desc(agentEvent.seq))
    .limit(1)
    .as("le");
  const conds: SQL[] = [eq(agentRun.tenantId, tenantId)];
  if (f.agent) conds.push(eq(agentRun.agent, f.agent));
  if (f.state && (RUN_STATES as readonly string[]).includes(f.state)) conds.push(eq(agentRun.status, f.state));
  if (f.jobId && /^[0-9a-f-]{36}$/i.test(f.jobId)) conds.push(eq(agentRun.jobId, f.jobId));

  const [runs, summary, stateCounts] = await Promise.all([
    db
      .select({
        id: agentRun.id,
        agent: agentRun.agent,
        task: agentRun.task,
        status: agentRun.status,
        attempt: agentRun.attempt,
        provider: agentRun.provider,
        model: agentRun.model,
        costUsd: agentRun.costUsd,
        inputTokens: agentRun.inputTokens,
        outputTokens: agentRun.outputTokens,
        summary: agentRun.summary,
        error: agentRun.error,
        dependencies: agentRun.dependencies,
        startedAt: agentRun.startedAt,
        finishedAt: agentRun.finishedAt,
        createdAt: agentRun.createdAt,
        jobId: agentRun.jobId,
        subjectType: agentRun.subjectType,
        subjectId: agentRun.subjectId,
        jobTitle: job.title,
        eventMessage: le.message,
        eventType: le.type,
      })
      .from(agentRun)
      .leftJoinLateral(le, sql`true`)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .where(and(...conds))
      .orderBy(sql`case ${agentRun.status} when 'running' then 0 when 'queued' then 1 else 2 end`, desc(agentRun.createdAt))
      .limit(200),
    db.execute(sql`
      select agent,
        count(*) filter (where created_at > now() - interval '24 hours')::int as runs24h,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed24h,
        coalesce(sum(cost_usd) filter (where created_at > now() - interval '24 hours'), 0)::float8 as cost24h,
        max(coalesce(finished_at, started_at, created_at)) as last_at
      from agent_run where tenant_id = ${tenantId} group by agent
    `) as unknown as Promise<{ agent: string; runs24h: number; running: number; queued: number; failed24h: number; cost24h: number; last_at: Date | null }[]>,
    db.execute(sql`select status, count(*)::int as n from agent_run where tenant_id = ${tenantId} group by status`) as unknown as Promise<{ status: RunState; n: number }[]>,
  ]);
  return { runs, summary, stateCounts: Object.fromEntries(stateCounts.map((s) => [s.status, s.n])) as Partial<Record<RunState, number>> };
}
