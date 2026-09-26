import { sql } from "drizzle-orm";
import journal from "../migrations/meta/_journal.json";
import type { Executor } from "./client";

/**
 * Migrations bundled with this build (the drizzle journal is compiled into the
 * worker bundle). drizzle's migrator records each applied migration's journal
 * `when` as `created_at`, so "the database is on this build's schema" means:
 * at least as many rows as bundled entries AND the newest row is the newest
 * bundled migration.
 */
export const BUNDLED_MIGRATIONS = {
  count: journal.entries.length,
  latestTag: journal.entries[journal.entries.length - 1]?.tag ?? null,
  latestWhen: journal.entries[journal.entries.length - 1]?.when ?? null,
};

export interface MigrationStatus {
  ok: boolean;
  applied: number;
  bundled: number;
  latestTag: string | null;
  detail: string;
}

export async function migrationStatus(db: Executor): Promise<MigrationStatus> {
  const base = { bundled: BUNDLED_MIGRATIONS.count, latestTag: BUNDLED_MIGRATIONS.latestTag };
  try {
    const rows = (await db.execute(
      sql`select count(*)::int as n, max(created_at)::text as latest from drizzle.__drizzle_migrations`,
    )) as unknown as { n: number; latest: string | null }[];
    const applied = Number(rows[0]?.n ?? 0);
    const latest = rows[0]?.latest === null || rows[0]?.latest === undefined ? null : Number(rows[0].latest);
    const ok = applied >= BUNDLED_MIGRATIONS.count && latest !== null && latest === BUNDLED_MIGRATIONS.latestWhen;
    return {
      ok,
      applied,
      ...base,
      detail: ok ? `schema at ${BUNDLED_MIGRATIONS.latestTag}` : `database has ${applied} migration(s) (latest ${latest ?? "none"}); this build expects ${BUNDLED_MIGRATIONS.count} ending ${BUNDLED_MIGRATIONS.latestTag}`,
    };
  } catch {
    return { ok: false, applied: 0, ...base, detail: "migration journal table not readable" };
  }
}
