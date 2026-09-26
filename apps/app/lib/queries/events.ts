import "server-only";
import { agentEvent, and, desc, eq, getDb, gt, asc, or } from "@gigpilot/db";

type SQL = ReturnType<typeof eq>;
import type { LiveEvent } from "../live-types";

function toLive(r: typeof agentEvent.$inferSelect): LiveEvent {
  return {
    id: r.id,
    seq: r.seq,
    type: r.type,
    level: r.level,
    agent: r.agent,
    message: r.message,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    jobId: r.jobId,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Most recent events for a tenant (newest first), optionally scoped to a subject/job. */
export async function listRecentEvents(tenantId: string, opts: { limit?: number; subjectIds?: string[]; jobId?: string } = {}): Promise<LiveEvent[]> {
  const conds: SQL[] = [eq(agentEvent.tenantId, tenantId)];
  const scoped: SQL[] = [];
  for (const id of opts.subjectIds ?? []) scoped.push(eq(agentEvent.subjectId, id));
  if (opts.jobId) scoped.push(eq(agentEvent.jobId, opts.jobId));
  if (scoped.length) conds.push(or(...scoped)!);
  const rows = await getDb()
    .select()
    .from(agentEvent)
    .where(and(...conds))
    .orderBy(desc(agentEvent.seq))
    .limit(opts.limit ?? 40);
  return rows.map(toLive);
}

/** Events after a cursor (oldest first) — used by the SSE stream. */
export async function listEventsAfter(tenantId: string, afterSeq: number, limit = 200): Promise<LiveEvent[]> {
  const rows = await getDb()
    .select()
    .from(agentEvent)
    .where(and(eq(agentEvent.tenantId, tenantId), gt(agentEvent.seq, afterSeq)))
    .orderBy(asc(agentEvent.seq))
    .limit(limit);
  return rows.map(toLive);
}
