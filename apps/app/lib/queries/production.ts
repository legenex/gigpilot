import "server-only";
import { agentRun, and, asc, asset, desc, eq, generation, getDb, inArray, job, repair, sql, workflow, workflowStep } from "@gigpilot/db";

export async function getProduction(tenantId: string, jobId?: string, stepKey?: string) {
  const db = getDb();
  const jobs = (await db.execute(sql`
    select j.id, j.title, j.status, j.actual_cost_usd::float8 as actual, j.spend_limit_usd::float8 as lim, j.updated_at,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status in ('succeeded','skipped'))::int as done,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status <> 'cancelled')::int as total,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status = 'running')::int as running,
      (select count(*) from workflow_step s where s.job_id = j.id and s.status in ('failed','blocked'))::int as failed
    from job j where j.tenant_id = ${tenantId}
      and (j.status not in ('closed','cancelled','delivered') or j.updated_at > now() - interval '14 days')
    order by case when j.status in ('executing','qa','repairing','planning','intake') then 0 when j.status = 'awaiting_final_approval' then 1 else 2 end, j.updated_at desc
    limit 50
  `)) as unknown as { id: string; title: string; status: string; actual: number; lim: number; updated_at: Date; done: number; total: number; running: number; failed: number }[];

  // Jobs with steps actually running first (stable within the SQL ordering).
  jobs.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || Number(b.total > 0) - Number(a.total > 0));
  const selectedId = jobId && jobs.some((j) => j.id === jobId) ? jobId : jobs[0]?.id;
  if (!selectedId) return { jobs, selected: null };

  const [jr] = await db.select().from(job).where(and(eq(job.id, selectedId), eq(job.tenantId, tenantId))).limit(1);
  const [wf] = await db.select().from(workflow).where(and(eq(workflow.jobId, selectedId), eq(workflow.tenantId, tenantId))).orderBy(desc(workflow.version)).limit(1);
  const steps = wf ? await db.select().from(workflowStep).where(and(eq(workflowStep.workflowId, wf.id), eq(workflowStep.tenantId, tenantId))).orderBy(asc(workflowStep.position)) : [];
  const repairs = await db.select().from(repair).where(and(eq(repair.jobId, selectedId), eq(repair.tenantId, tenantId))).orderBy(desc(repair.createdAt));
  const step = steps.find((s) => s.key === stepKey) ?? steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "failed") ?? null;

  let stepRuns: (typeof agentRun.$inferSelect)[] = [];
  let stepGenerations: (typeof generation.$inferSelect)[] = [];
  let stepAssets: (typeof asset.$inferSelect)[] = [];
  if (step) {
    [stepRuns, stepGenerations, stepAssets] = await Promise.all([
      db.select().from(agentRun).where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.stepId, step.id))).orderBy(desc(agentRun.attempt), desc(agentRun.createdAt)),
      db.select().from(generation).where(and(eq(generation.tenantId, tenantId), eq(generation.stepId, step.id))).orderBy(desc(generation.createdAt)).limit(30),
      db.select().from(asset).where(and(eq(asset.tenantId, tenantId), eq(asset.stepId, step.id))).orderBy(asc(asset.createdAt)).limit(20),
    ]);
  }
  const runCounts = steps.length
    ? await db
        .select({ stepId: agentRun.stepId, n: sql<number>`count(*)::int` })
        .from(agentRun)
        .where(and(eq(agentRun.tenantId, tenantId), inArray(agentRun.stepId, steps.map((s) => s.id))))
        .groupBy(agentRun.stepId)
    : [];

  return {
    jobs,
    selected: jr ? { job: jr, workflow: wf ?? null, steps, repairs, step, stepRuns, stepGenerations, stepAssets, runCounts: Object.fromEntries(runCounts.map((r) => [r.stepId, r.n])) } : null,
  };
}
