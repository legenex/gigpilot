import "server-only";
import { agentRun, and, eq, getDb, inArray, isNull, job, notification, opportunity, proposal, sql } from "@gigpilot/db";

export interface NavCounts {
  pursue: number;
  proposalsAwaiting: number;
  awaitingFinal: number;
  unread: number;
  runningAgents: number;
}

/** Badge counts for the rail — cheap indexed counts, tenant-scoped. */
export async function getNavCounts(tenantId: string): Promise<NavCounts> {
  const db = getDb();
  const [pursue, props, finals, unread, running] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunity)
      .where(and(eq(opportunity.tenantId, tenantId), eq(opportunity.recommendation, "pursue"), inArray(opportunity.status, ["analysed", "shortlisted"]))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(proposal)
      .where(and(eq(proposal.tenantId, tenantId), eq(proposal.status, "awaiting_approval"))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(job)
      .where(and(eq(job.tenantId, tenantId), eq(job.status, "awaiting_final_approval"))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(eq(notification.tenantId, tenantId), isNull(notification.readAt))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRun)
      .where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.status, "running"))),
  ]);
  return {
    pursue: pursue[0]?.n ?? 0,
    proposalsAwaiting: props[0]?.n ?? 0,
    awaitingFinal: finals[0]?.n ?? 0,
    unread: unread[0]?.n ?? 0,
    runningAgents: running[0]?.n ?? 0,
  };
}

/** Highest event cursor for the tenant (SSE resumes after it). */
export async function getLatestSeq(tenantId: string): Promise<number> {
  const rows = (await getDb().execute(sql`select coalesce(max(seq), 0)::int as seq from agent_event where tenant_id = ${tenantId}`)) as unknown as { seq: number }[];
  return rows[0]?.seq ?? 0;
}
