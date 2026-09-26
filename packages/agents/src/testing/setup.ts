/**
 * Test harness for DB-backed agent tests. Import this module FIRST in a test
 * file: it loads the root .env, points DATABASE_URL at the dedicated
 * `gigpilot_test` database, forces mock mode (no provider keys, $0 paid
 * budget) and uses a throwaway storage root.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_KEYS = [
  "GX_API_KEY",
  "GX_BASE_URL",
  "FACTORY_API_KEY",
  "XAI_API_KEY",
  "KIE_API_KEY",
  "HIGGSFIELD_API_KEY",
  "HIGGSFIELD_API_SECRET",
  "UPWORK_CLIENT_ID",
  "UPWORK_CLIENT_SECRET",
  "FREELANCER_OAUTH_TOKEN",
];

export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2]!.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

export function testDatabaseUrl(base = process.env.DATABASE_URL): string {
  const u = new URL(base ?? "postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot");
  u.pathname = "/gigpilot_test";
  return u.toString();
}

let applied = false;

export function applyTestEnv(): void {
  if (applied) return;
  applied = true;
  loadDotEnv(path.join(repoRoot(), ".env"));
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.GIGPILOT_SERVICE = "gigpilot-test";
  process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "0";
  process.env.WORKER_SCHEDULES_ENABLED = "false";
  process.env.STORAGE_DRIVER = "filesystem";
  // One storage dir per test run (forks share the vitest parent pid); stale runs are pruned.
  const base = path.join(os.tmpdir(), "gigpilot-test-storage");
  mkdirSync(base, { recursive: true });
  for (const d of readdirSync(base)) {
    try {
      if (Date.now() - statSync(path.join(base, d)).mtimeMs > 3_600_000) rmSync(path.join(base, d), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const storageRoot = path.join(base, String(process.ppid));
  mkdirSync(storageRoot, { recursive: true });
  process.env.STORAGE_ROOT = storageRoot;
  for (const k of PROVIDER_KEYS) delete process.env[k];
}

applyTestEnv();
