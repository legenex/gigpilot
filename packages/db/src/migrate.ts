import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "./client";

/**
 * Applies pending SQL migrations. Used by the one-shot `migrate` compose
 * service and by `pnpm db:migrate`. Safe to run repeatedly.
 */
export async function runMigrations(migrationsFolder?: string): Promise<void> {
  const folder =
    migrationsFolder ??
    process.env.MIGRATIONS_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  await migrate(getDb(), { migrationsFolder: folder });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const started = Date.now();
  runMigrations()
    .then(async () => {
      console.log(JSON.stringify({ level: "info", msg: "migrations applied", ms: Date.now() - started }));
      await closeDb();
    })
    .catch(async (err) => {
      console.error(JSON.stringify({ level: "error", msg: "migration failed", error: String(err) }));
      await closeDb();
      process.exit(1);
    });
}
