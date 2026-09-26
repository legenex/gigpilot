import "../../../packages/agents/src/testing/setup";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@gigpilot/db";
import { migrateTestDb, resetDb } from "../../../packages/agents/src/testing/harness";
import { bearerMatches, startHealthServer, TRIGGER_ALLOWLIST, type SupervisionDeps } from "./server";
import { buildSnapshot, createErrorRing, pendingItems } from "./status";

const TOKEN = "test-supervision-token-0123456789";

async function serve(overrides: Partial<SupervisionDeps> = {}) {
  const enqueued: string[] = [];
  const deps: SupervisionDeps = {
    token: TOKEN,
    startedAt: Date.now(),
    snapshot: () => buildSnapshot(null, createErrorRing(), { bossStarted: true }),
    pending: () => pendingItems(),
    enqueue: async (q) => {
      enqueued.push(q);
      return `job-${enqueued.length}`;
    },
    readiness: async () => ({ ready: true, checks: { database: true } }),
    ...overrides,
  };
  const server: Server = await startHealthServer(deps, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, enqueued };
}

describe("worker health & supervision API", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("serves liveness and readiness without auth", async () => {
    const { server, base } = await serve({ readiness: async () => ({ ready: false, checks: { database: false } }) });
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: "not_ready" });
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("requires the bearer token (503 when unset, 401 when wrong) and returns the snapshot", async () => {
    const disabled = await serve({ token: undefined });
    try {
      expect((await fetch(`${disabled.base}/api/supervision/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
    } finally {
      disabled.server.close();
    }
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/api/supervision/status`)).status).toBe(401);
      expect((await fetch(`${base}/api/supervision/status`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      const ok = await fetch(`${base}/api/supervision/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      const snap = (await ok.json()) as { service: string; health: string; pending: Record<string, number> };
      expect(snap.service).toBe("gigpilot");
      expect(snap.health).toBe("ok");
      expect(snap.pending).toMatchObject({ approvals: 0, activeJobs: 0 });
      const pending = await fetch(`${base}/api/supervision/pending`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(await pending.json()).toMatchObject({ count: 0, items: [] });
    } finally {
      server.close();
    }
  });

  it("triggers only allowlisted jobs, once per Idempotency-Key", async () => {
    const { server, base, enqueued } = await serve();
    const post = (name: string, key?: string) =>
      fetch(`${base}/api/supervision/trigger/${name}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(key ? { "idempotency-key": key } : {}) } });
    try {
      const first = await post("metrics-rollup", "key-00000001");
      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ jobId: "job-1", queue: "metrics-rollup" });
      const again = await post("metrics-rollup", "key-00000001");
      expect(await again.json()).toMatchObject({ deduped: true, jobId: "job-1" });
      expect(enqueued).toEqual(["metrics-rollup"]);
      expect((await post("health-sweep", "key-00000002")).status).toBe(202);
      expect(enqueued).toEqual(["metrics-rollup", "provider-health"]);
      expect((await post("metrics-rollup")).status).toBe(400);
      expect((await post("application-submit", "key-00000003")).status).toBe(404);
      expect((await fetch(`${base}/api/supervision/trigger/metrics-rollup`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
      expect(Object.values(TRIGGER_ALLOWLIST)).not.toContain("application-submit");
    } finally {
      server.close();
    }
  });

  it("compares tokens in constant time over digests", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});
