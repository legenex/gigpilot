import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { QUEUES, type QueueName } from "@gigpilot/contracts";
import { eq, getDb, idempotencyKey, pingDb } from "@gigpilot/db";
import type { AgentOSStatusSnapshot } from "@gigpilot/providers";
import type { PendingItem } from "./status";

/**
 * Worker health + AgentOS supervision API (node:http, loopback by default).
 *   GET  /healthz                          liveness (no auth)
 *   GET  /readyz                           readiness: db, queue, migrations, schedule freshness (no auth)
 *   GET  /api/supervision/status           bearer → AgentOSStatusSnapshot
 *   GET  /api/supervision/pending          bearer → items waiting on a human (ids/counts only)
 *   POST /api/supervision/trigger/<name>   bearer + Idempotency-Key → enqueue an allowlisted maintenance job
 * Supervision routes return 503 when AGENTOS_SUPERVISION_TOKEN is unset.
 */

/** Safe, reversible, internal jobs only (never submissions, client messages, approvals or spend). */
export const TRIGGER_ALLOWLIST: Record<string, QueueName> = {
  "source-refresh-all": QUEUES.sourceRefreshAll,
  "market-research-all": QUEUES.marketResearchAll,
  "provider-health": QUEUES.providerHealth,
  "job-monitor": QUEUES.jobMonitor,
  "metrics-rollup": QUEUES.metricsRollup,
  // Aliases documented in ops/agentos/README.md
  "health-sweep": QUEUES.providerHealth,
  "source-sync": QUEUES.sourceRefreshAll,
  "expire-stale": QUEUES.opportunityExpire,
};

export interface SupervisionDeps {
  token: string | undefined;
  snapshot(): Promise<AgentOSStatusSnapshot>;
  pending(): Promise<PendingItem[]>;
  enqueue(queue: QueueName): Promise<string | null>;
  readiness(): Promise<{ ready: boolean; checks: Record<string, boolean | string | number> }>;
  startedAt: number;
  log?: { warn(obj: object, msg?: string): void; info(obj: object, msg?: string): void };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(json);
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  // Constant-time comparison of fixed-length digests (no length oracle).
  return timingSafeEqual(digest(m[1]!.trim()), digest(token));
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: SupervisionDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") {
    return send(res, 200, { status: "ok", service: "gigpilot-worker", uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000) });
  }
  if (method === "GET" && path === "/readyz") {
    const r = await deps.readiness();
    return send(res, r.ready ? 200 : 503, { status: r.ready ? "ready" : "not_ready", checks: r.checks });
  }

  if (path.startsWith("/api/supervision")) {
    if (!deps.token) return send(res, 503, { error: "supervision API disabled (AGENTOS_SUPERVISION_TOKEN not set)" });
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      deps.log?.warn({ path, method }, "supervision auth rejected");
      return send(res, 401, { error: "unauthorized" });
    }
    if (method === "GET" && path === "/api/supervision/status") return send(res, 200, await deps.snapshot());
    if (method === "GET" && path === "/api/supervision/pending") {
      const items = await deps.pending();
      return send(res, 200, { generatedAt: new Date().toISOString(), count: items.length, items });
    }
    const trigger = /^\/api\/supervision\/trigger\/([a-z0-9-]{1,64})$/.exec(path);
    if (trigger) {
      if (method !== "POST") return send(res, 405, { error: "method not allowed" });
      const name = trigger[1]!;
      const queue = TRIGGER_ALLOWLIST[name];
      if (!queue) return send(res, 404, { error: `unknown trigger '${name}'`, allowed: Object.keys(TRIGGER_ALLOWLIST) });
      const idem = (req.headers["idempotency-key"] as string | undefined)?.trim();
      if (!idem || !/^[A-Za-z0-9._:-]{8,200}$/.test(idem)) return send(res, 400, { error: "Idempotency-Key header required (8–200 chars: A-Z a-z 0-9 . _ : -)" });
      const key = `supervision:${name}:${createHash("sha256").update(idem).digest("hex").slice(0, 40)}`;
      const db = getDb();
      const claimed = await db.insert(idempotencyKey).values({ key, tenantId: null, scope: "supervision.trigger", result: null }).onConflictDoNothing().returning({ key: idempotencyKey.key });
      if (claimed.length === 0) {
        const [prev] = await db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key)).limit(1);
        return send(res, 202, { deduped: true, trigger: name, queue, ...((prev?.result as Record<string, unknown> | null) ?? {}) });
      }
      const jobId = await deps.enqueue(queue);
      await db.update(idempotencyKey).set({ result: { jobId, queue, at: new Date().toISOString() } }).where(eq(idempotencyKey.key, key));
      deps.log?.info({ trigger: name, queue, jobId }, "supervision trigger enqueued");
      return send(res, 202, { jobId, trigger: name, queue });
    }
    return send(res, 404, { error: "not found" });
  }
  return send(res, 404, { error: "not found" });
}

export function startHealthServer(deps: SupervisionDeps, opts: { port: number; host: string }): Promise<Server> {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      deps.log?.warn({ error: err instanceof Error ? err.name : "error" }, "health server request failed");
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export { pingDb };
