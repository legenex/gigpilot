import { createHmac } from "node:crypto";
import { getDb, sql } from "@gigpilot/db";
import { normalizeEmail } from "./policy";

/**
 * Per-account sign-in backoff, independent of the client IP (security review
 * M2). After MAX_FAILURES failed password attempts for one email within
 * WINDOW_MS, sign-in for that email is refused for LOCK_MS — no matter how
 * many IPs the attempts come from.
 *
 * Storage: the existing Better Auth `rate_limit` table, keyed
 * `signin:<hmac(email)>` (the address itself is never stored). Unlike Better
 * Auth's own rows, `last_request` holds the row's EXPIRY time (window end or
 * lock end, epoch ms): Better Auth prunes rows whose last_request is older
 * than its longest window, so storing a future expiry keeps our rows alive
 * exactly until they stop mattering.
 */

export const SIGNIN_MAX_FAILURES = 5;
export const SIGNIN_WINDOW_MS = 15 * 60_000;
export const SIGNIN_LOCK_MS = 15 * 60_000;

export interface BackoffRow {
  count: number;
  /** Expiry (epoch ms): window end while counting, lock end once locked. */
  expiresAt: number;
}

/** Pure: is this row a live lock? Returns the remaining ms (0 = not locked). */
export function lockRemainingMs(row: BackoffRow | null | undefined, now: number): number {
  if (!row) return 0;
  if (row.count < SIGNIN_MAX_FAILURES) return 0;
  return Math.max(0, row.expiresAt - now);
}

/** Pure: the row after one more failure (mirrors the SQL upsert below). */
export function afterFailure(row: BackoffRow | null | undefined, now: number): BackoffRow {
  if (!row || row.expiresAt <= now) return { count: 1, expiresAt: now + SIGNIN_WINDOW_MS };
  const count = row.count + 1;
  return { count, expiresAt: count >= SIGNIN_MAX_FAILURES ? now + SIGNIN_LOCK_MS : row.expiresAt };
}

export function signinBackoffKey(email: string): string {
  const pepper = process.env.BETTER_AUTH_SECRET || "gigpilot-signin-backoff";
  return `signin:${createHmac("sha256", pepper).update(normalizeEmail(email)).digest("hex").slice(0, 40)}`;
}

type Row = Record<string, unknown>;

export async function readBackoff(email: string): Promise<BackoffRow | null> {
  const key = signinBackoffKey(email);
  const rows = (await getDb().execute(sql`select count, last_request from rate_limit where key = ${key} limit 1`)) as unknown as Row[];
  const r = rows[0];
  return r ? { count: Number(r.count), expiresAt: Number(r.last_request) } : null;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Atomic increment (single upsert; concurrent failures cannot under-count).
 * `rate_limit` has TWO unique indexes (id pk + key) and Postgres arbitrates
 * ON CONFLICT on the named one only, so two first-time inserts racing can
 * still trip the primary key (23505) even though id = key. The retry then
 * sees the committed row and takes the ON CONFLICT path.
 */
export async function recordSigninFailure(email: string, now: number = Date.now()): Promise<BackoffRow> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await upsertFailure(email, now);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 5) throw err;
    }
  }
}

async function upsertFailure(email: string, now: number): Promise<BackoffRow> {
  const key = signinBackoffKey(email);
  const windowEnd = now + SIGNIN_WINDOW_MS;
  const lockEnd = now + SIGNIN_LOCK_MS;
  const rows = (await getDb().execute(sql`
    insert into rate_limit (id, key, count, last_request) values (${key}, ${key}, 1, ${windowEnd})
    on conflict (key) do update set
      count = case when rate_limit.last_request <= ${now} then 1 else rate_limit.count + 1 end,
      last_request = case
        when rate_limit.last_request <= ${now} then ${windowEnd}
        when rate_limit.count + 1 >= ${SIGNIN_MAX_FAILURES} then ${lockEnd}
        else rate_limit.last_request end
    returning count, last_request
  `)) as unknown as Row[];
  const r = rows[0];
  return { count: Number(r?.count ?? 1), expiresAt: Number(r?.last_request ?? windowEnd) };
}

export async function clearSigninFailures(email: string): Promise<void> {
  const key = signinBackoffKey(email);
  await getDb().execute(sql`delete from rate_limit where key = ${key}`);
}
