import { sql } from "drizzle-orm";
import type { AgentKey, EventLevel, EventType, SubjectType } from "@gigpilot/contracts";
import type { Executor } from "./client";
import { agentEvent } from "./schema";

export interface EmitEventInput {
  tenantId: string | null;
  type: EventType;
  message: string;
  level?: EventLevel;
  agent?: AgentKey | null;
  runId?: string | null;
  subjectType?: SubjectType | null;
  subjectId?: string | null;
  jobId?: string | null;
  data?: Record<string, unknown> | null;
}

export const EVENTS_CHANNEL = "gigpilot_events";

/** Append to the live activity stream and notify listeners (LISTEN gigpilot_events). */
export async function emitEvent(db: Executor, input: EmitEventInput): Promise<void> {
  await db.insert(agentEvent).values({
    tenantId: input.tenantId,
    type: input.type,
    message: input.message,
    level: input.level ?? "info",
    agent: input.agent ?? null,
    runId: input.runId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    jobId: input.jobId ?? null,
    data: input.data ?? null,
  });
  if (input.tenantId) {
    await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${input.tenantId})`);
  }
}
