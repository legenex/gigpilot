import { env, OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import type { TenantSettings } from "@gigpilot/contracts";
import { advisoryXactLock, and, costLedgerEntry, eq, getDb, gte, job, lt, spendReservation, sql, tenantPaidSpendCeilingUsd, type Executor } from "@gigpilot/db";
import type { BudgetContext } from "@gigpilot/providers";
import { round4, startOfUtcDay } from "./util";

/**
 * Hard spend limits. Every paid provider call RESERVES its expected cost
 * before it runs — inside a transaction that holds the global and per-tenant
 * budget advisory locks and recomputes what remains (today's paid actuals +
 * other open reservations, for the deployment budget, the tenant's daily
 * limit and the job's spend limit). Two concurrent calls therefore cannot
 * both pass a check that only one of them fits. After the call the
 * reservation is settled (the actual lands in cost_ledger_entry) or released.
 */

const reservationTtlMs = () => OPERATIONAL_DEFAULTS.spendReservationTtlMinutes * 60_000;

async function paidSpentSince(db: Executor, since: Date, tenantId?: string): Promise<number> {
  const conds = [eq(costLedgerEntry.paid, true), eq(costLedgerEntry.kind, "actual"), gte(costLedgerEntry.createdAt, since)];
  if (tenantId) conds.push(eq(costLedgerEntry.tenantId, tenantId));
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${costLedgerEntry.amountUsd}), 0)` })
    .from(costLedgerEntry)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

async function openReserved(db: Executor, now: Date, scope: { tenantId?: string; jobId?: string }): Promise<number> {
  const conds = [eq(spendReservation.status, "open"), gte(spendReservation.createdAt, new Date(now.getTime() - reservationTtlMs()))];
  if (scope.tenantId) conds.push(eq(spendReservation.tenantId, scope.tenantId));
  if (scope.jobId) conds.push(eq(spendReservation.jobId, scope.jobId));
  const [row] = await db
    .select({ total: sql<string | null>`coalesce(sum(${spendReservation.amountUsd}), 0)` })
    .from(spendReservation)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

export interface BudgetSnapshot extends BudgetContext {
  /** Remaining under the job's spend limit (Infinity when no job). */
  jobRemainingUsd: number;
}

/**
 * Remaining paid authority = min(env budget − today's paid spend − open
 * reservations (all tenants), tenant limit − today's tenant paid spend − the
 * tenant's open reservations, job limit − job actual − the job's open
 * reservations). Paid providers are allowed only when BOTH the env budget and
 * the tenant limit are > 0.
 */
export async function budgetSnapshot(
  db: Executor,
  tenantId: string,
  settings: TenantSettings,
  opts: { jobId?: string | null; now?: Date } = {},
): Promise<BudgetSnapshot> {
  const now = opts.now ?? new Date();
  let jobRemainingUsd = Number.POSITIVE_INFINITY;
  if (opts.jobId) {
    const [j] = await db.select({ limit: job.spendLimitUsd, actual: job.actualCostUsd }).from(job).where(eq(job.id, opts.jobId)).limit(1);
    if (j) jobRemainingUsd = Number(j.limit) - Number(j.actual) - (await openReserved(db, now, { jobId: opts.jobId }));
  }
  const envBudget = env().PAID_PROVIDER_DAILY_BUDGET_USD;
  // Clamp to the operator-controlled ceiling so a limit saved earlier (or written
  // directly) can never exceed what the operator allows this workspace.
  const tenantLimit = Math.min(settings.limits.dailyPaidSpendLimitUsd, await tenantPaidSpendCeilingUsd(db, tenantId));
  if (!(envBudget > 0) || !(tenantLimit > 0)) return { allowPaid: false, remainingPaidUsd: 0, jobRemainingUsd: Math.max(0, jobRemainingUsd) };
  const since = startOfUtcDay(now);
  const [globalSpent, tenantSpent, globalReserved, tenantReserved] = await Promise.all([
    paidSpentSince(db, since),
    paidSpentSince(db, since, tenantId),
    openReserved(db, now, {}),
    openReserved(db, now, { tenantId }),
  ]);
  const remaining = Math.min(envBudget - globalSpent - globalReserved, tenantLimit - tenantSpent - tenantReserved, jobRemainingUsd);
  return { allowPaid: true, remainingPaidUsd: Math.max(0, remaining), jobRemainingUsd: Math.max(0, jobRemainingUsd) };
}

export type ReserveResult = { ok: true; id: string; amountUsd: number } | { ok: false; remainingUsd: number; reason: string };

/**
 * Reserve paid spend for one call. Reserves `amountUsd` (or as much as
 * remains, but never less than `minAmountUsd`). Serialised per deployment and
 * per tenant with transaction-scoped advisory locks.
 */
export async function reserveSpend(input: {
  tenantId: string;
  jobId?: string | null;
  stepId?: string | null;
  key: string;
  amountUsd: number;
  minAmountUsd?: number;
  provider?: string | null;
  memo?: string;
  settings: TenantSettings;
  now?: Date;
}): Promise<ReserveResult> {
  const want = round4(Math.max(0, input.amountUsd));
  const min = round4(Math.max(0, input.minAmountUsd ?? want));
  return getDb().transaction(async (tx) => {
    // Same lock order everywhere (global → tenant) so reservations never deadlock.
    await advisoryXactLock(tx, "budget:global");
    await advisoryXactLock(tx, `budget:${input.tenantId}`);
    const snap = await budgetSnapshot(tx, input.tenantId, input.settings, { jobId: input.jobId, now: input.now });
    if (!snap.allowPaid) return { ok: false as const, remainingUsd: 0, reason: "paid spend is disabled" };
    const available = round4(snap.remainingPaidUsd);
    if (available + 1e-9 < min) {
      return {
        ok: false as const,
        remainingUsd: available,
        reason: snap.jobRemainingUsd + 1e-9 < min ? "the job's spend limit" : "the daily paid budget",
      };
    }
    const amount = Math.min(want, available);
    const [row] = await tx
      .insert(spendReservation)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId ?? null,
        stepId: input.stepId ?? null,
        key: input.key,
        provider: input.provider ?? null,
        amountUsd: round4(Math.max(amount, min)),
        status: "open",
        memo: (input.memo ?? "").slice(0, 300),
      })
      .onConflictDoNothing()
      .returning({ id: spendReservation.id, amountUsd: spendReservation.amountUsd });
    if (!row) return { ok: false as const, remainingUsd: available, reason: "a reservation with this key already exists" };
    return { ok: true as const, id: row.id, amountUsd: Number(row.amountUsd) };
  });
}

/** Close a reservation: the actual cost is recorded in the ledger by the caller. */
export async function settleReservation(id: string | null | undefined, actualUsd: number): Promise<void> {
  if (!id) return;
  await getDb()
    .update(spendReservation)
    .set({ status: "settled", actualUsd: round4(Math.max(0, actualUsd)), settledAt: new Date() })
    .where(and(eq(spendReservation.id, id), eq(spendReservation.status, "open")));
}

export async function releaseReservation(id: string | null | undefined, memo?: string): Promise<void> {
  if (!id) return;
  await getDb()
    .update(spendReservation)
    .set({ status: "released", settledAt: new Date(), ...(memo ? { memo: memo.slice(0, 300) } : {}) })
    .where(and(eq(spendReservation.id, id), eq(spendReservation.status, "open")));
}

/** Release reservations left open by a worker that died mid-call (job monitor). */
export async function releaseStaleReservations(now: Date): Promise<number> {
  const rows = await getDb()
    .update(spendReservation)
    .set({ status: "released", settledAt: now, memo: "released: stale (worker stopped mid-call)" })
    .where(and(eq(spendReservation.status, "open"), lt(spendReservation.createdAt, new Date(now.getTime() - reservationTtlMs()))))
    .returning({ id: spendReservation.id });
  return rows.length;
}
