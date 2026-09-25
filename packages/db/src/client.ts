import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or a transaction. */
export type Executor = Db | Tx;

interface DbGlobal {
  __gigpilotSql?: postgres.Sql;
  __gigpilotDb?: Db;
}
const g = globalThis as unknown as DbGlobal;

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot";
}

/**
 * Process-wide singleton. Next.js dev/hot-reload and multiple route modules
 * share one pool instead of exhausting connections.
 */
export function getSql(): postgres.Sql {
  if (!g.__gigpilotSql) {
    g.__gigpilotSql = postgres(databaseUrl(), {
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: true,
      onnotice: () => {},
      connection: { application_name: process.env.GIGPILOT_SERVICE ?? "gigpilot" },
    });
  }
  return g.__gigpilotSql;
}

export function getDb(): Db {
  if (!g.__gigpilotDb) g.__gigpilotDb = drizzle(getSql(), { schema, casing: undefined });
  return g.__gigpilotDb;
}

export async function closeDb(): Promise<void> {
  if (g.__gigpilotSql) {
    await g.__gigpilotSql.end({ timeout: 5 });
    g.__gigpilotSql = undefined;
    g.__gigpilotDb = undefined;
  }
}

export async function pingDb(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await getSql()`select 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
