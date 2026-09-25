import { and, eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { assertTransition, InvalidTransitionError, type Machine } from "@gigpilot/contracts";
import type { Executor } from "./client";
import { agentRun, application, auditEvent, delivery, job, opportunity, proposal, workflowStep } from "./schema";
import { emitEvent, type EmitEventInput } from "./events";

export interface Actor {
  type: "user" | "agent" | "system";
  id?: string | null;
}

type StatusTable = PgTable & { id: PgColumn; status: PgColumn };

const TABLES: Record<Machine, StatusTable> = {
  opportunity: opportunity as unknown as StatusTable,
  proposal: proposal as unknown as StatusTable,
  application: application as unknown as StatusTable,
  job: job as unknown as StatusTable,
  step: workflowStep as unknown as StatusTable,
  run: agentRun as unknown as StatusTable,
  delivery: delivery as unknown as StatusTable,
};

const SUBJECT: Record<Machine, string> = {
  opportunity: "opportunity",
  proposal: "proposal",
  application: "application",
  job: "job",
  step: "step",
  run: "agent_run",
  delivery: "delivery",
};

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConcurrentTransitionError extends Error {
  constructor(machine: Machine, id: string) {
    super(`Concurrent ${machine} transition detected for ${id}`);
    this.name = "ConcurrentTransitionError";
  }
}

export interface TransitionInput {
  machine: Machine;
  id: string;
  tenantId: string | null;
  to: string;
  actor: Actor;
  reason?: string;
  /** Extra column updates applied atomically with the status change. */
  patch?: Record<string, unknown>;
  /** Optional live-stream event written alongside the audit record. */
  event?: Omit<EmitEventInput, "tenantId">;
  /** Require the current state to be one of these (defensive precondition). */
  expectFrom?: string[];
}

export interface TransitionResult {
  changed: boolean;
  from: string;
  to: string;
}

/**
 * Validated, audited state transition with optimistic concurrency.
 * Idempotent: transitioning to the current state is a no-op (changed=false).
 * Must be called inside a transaction when combined with other writes.
 */
export async function transition(db: Executor, input: TransitionInput): Promise<TransitionResult> {
  const table = TABLES[input.machine];
  const rows = (await db
    .select({ status: table.status })
    .from(table)
    .where(eq(table.id, input.id))
    .limit(1)) as { status: string }[];
  const current = rows[0];
  if (!current) throw new NotFoundError(`${input.machine} ${input.id}`);
  if (current.status === input.to) return { changed: false, from: current.status, to: input.to };
  if (input.expectFrom && !input.expectFrom.includes(current.status)) {
    throw new InvalidTransitionError(input.machine, current.status, input.to);
  }
  assertTransition(input.machine, current.status, input.to);

  const updated = (await db
    .update(table)
    .set({ status: input.to, ...(input.patch ?? {}), ...(hasUpdatedAt(table) ? { updatedAt: new Date() } : {}) } as never)
    .where(and(eq(table.id, input.id), eq(table.status, current.status)))
    .returning({ id: table.id })) as { id: string }[];
  if (updated.length === 0) throw new ConcurrentTransitionError(input.machine, input.id);

  await db.insert(auditEvent).values({
    tenantId: input.tenantId,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    action: `${input.machine}.transition`,
    subjectType: SUBJECT[input.machine],
    subjectId: input.id,
    fromState: current.status,
    toState: input.to,
    data: input.reason ? { reason: input.reason } : null,
  });

  if (input.event) {
    await emitEvent(db, { ...input.event, tenantId: input.tenantId });
  }
  return { changed: true, from: current.status, to: input.to };
}

function hasUpdatedAt(table: StatusTable): boolean {
  return "updatedAt" in (table as unknown as Record<string, unknown>);
}

export async function audit(
  db: Executor,
  input: {
    tenantId: string | null;
    actor: Actor;
    action: string;
    subjectType: string;
    subjectId?: string | null;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditEvent).values({
    tenantId: input.tenantId,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    data: input.data ?? null,
  });
}

/** Postgres advisory lock helper for single-flight sections keyed by string. */
export async function tryAdvisoryXactLock(db: Executor, key: string): Promise<boolean> {
  const res = (await db.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as locked`)) as unknown as {
    locked: boolean;
  }[];
  return Boolean(res[0]?.locked);
}
