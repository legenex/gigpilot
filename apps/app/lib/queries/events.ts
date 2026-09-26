import "server-only";
import { agentEvent, and, desc, eq, getDb, gt, asc, inArray, lte, not, or, sql } from "@gigpilot/db";
import { SYSTEM_EVENT_TYPES } from "../labels";

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

/**
 * Most recent events for a tenant (newest first), optionally scoped to a
 * subject/job. Owner views pass `includeSystem: false` (default) so provider
 * health and queue plumbing don't crowd out business events.
 */
export async function listRecentEvents(tenantId: string, opts: { limit?: number; subjectIds?: string[]; jobId?: string; includeSystem?: boolean } = {}): Promise<LiveEvent[]> {
  const conds: SQL[] = [eq(agentEvent.tenantId, tenantId)];
  if (!opts.includeSystem) conds.push(not(inArray(agentEvent.type, [...SYSTEM_EVENT_TYPES])));
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

/**
 * Late commits: `seq` comes from a sequence, so a transaction that took its
 * seq earlier can commit AFTER a higher seq was already streamed. A pure
 * `seq > cursor` query would skip it forever. This returns rows at or below
 * the cursor (within `overlap` seqs) created in the last `windowSeconds`;
 * the stream de-duplicates them by event id.
 */
export async function listLateEvents(tenantId: string, cursor: number, opts: { overlap?: number; windowSeconds?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const overlap = opts.overlap ?? 500;
  const windowSeconds = opts.windowSeconds ?? 60;
  if (cursor <= 0) return [];
  const rows = await getDb()
    .select()
    .from(agentEvent)
    .where(
      and(
        eq(agentEvent.tenantId, tenantId),
        gt(agentEvent.seq, Math.max(0, cursor - overlap)),
        lte(agentEvent.seq, cursor),
        gt(agentEvent.createdAt, sql`now() - make_interval(secs => ${windowSeconds})`),
      ),
    )
    .orderBy(asc(agentEvent.seq))
    .limit(opts.limit ?? overlap);
  return rows.map(toLive);
}
