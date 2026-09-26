/**
 * GigPilot worker: durable pg-boss consumers for every queue, the recurring
 * scheduler, the orchestrator's workflow engine (via @gigpilot/agents
 * handlers), and a loopback health/supervision HTTP server for AgentOS.
 */
process.env.GIGPILOT_SERVICE ??= "gigpilot-worker";

import type { Server } from "node:http";
import { env } from "@gigpilot/config";
import { QUEUES, type QueueName } from "@gigpilot/contracts";
import { closeDb, pingDb } from "@gigpilot/db";
import { createBoss } from "@gigpilot/db/queue";
import { enqueuerFrom, handlers, type AgentDeps } from "@gigpilot/agents";
import { getAgentOSAdapter } from "@gigpilot/providers";
import { agentLogger, createLogger } from "./logger";
import { CONCURRENCY, SCHEDULES, SCHEDULED_QUEUES, pollingIntervalFor } from "./schedules";
import { startHealthServer } from "./server";
import { buildSnapshot, createErrorRing, migrationsApplied, pendingItems } from "./status";

type Boss = Awaited<ReturnType<typeof createBoss>>;

const log = createLogger();

function safeMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : err && typeof err === "object"
        ? String((err as { message?: unknown }).message ?? JSON.stringify(err))
        : String(err);
  return raw
    .replace(/(Bearer|Key)\s+[A-Za-z0-9._:-]+/gi, "$1 [redacted]")
    .replace(/\b(sk|fk|xai|gx)-[A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .replace(/postgres(ql)?:\/\/[^\s@]+@/gi, "postgres://[redacted]@")
    .slice(0, 400);
}

async function main(): Promise<void> {
  const cfg = env();
  const startedAt = Date.now();
  const errors = createErrorRing();
  let boss: Boss | null = null;
  let bossStarted = false;
  let lastScheduleTick: number | null = null;
  let stopping = false;
  const timers: NodeJS.Timeout[] = [];

  const db = await pingDb();
  if (!db.ok) log.warn({ latencyMs: db.latencyMs }, "database not reachable yet — pg-boss will retry");

  boss = await createBoss({ supervise: true, schedule: cfg.WORKER_SCHEDULES_ENABLED, max: 8 });
  bossStarted = true;
  boss.on("error", (err: unknown) => {
    errors.push(`queue: ${safeMessage(err)}`);
    log.error({ error: safeMessage(err) }, "pg-boss error");
  });
  const b = boss;
  const queue = enqueuerFrom(b);

  for (const name of Object.values(QUEUES) as QueueName[]) {
    const handler = handlers[name] as (payload: unknown, deps: AgentDeps) => Promise<unknown>;
    await b.work(name, { localConcurrency: CONCURRENCY[name] ?? 1, batchSize: 1, pollingIntervalSeconds: pollingIntervalFor(name) }, async (jobs) => {
      for (const job of jobs) {
        const data = (job.data ?? {}) as Record<string, unknown>;
        const child = log.child({ queue: name, jobId: job.id, tenantId: typeof data.tenantId === "string" ? data.tenantId : undefined });
        const deps: AgentDeps = { queue, log: agentLogger(child), now: () => new Date() };
        const started = Date.now();
        if (SCHEDULED_QUEUES.has(name)) lastScheduleTick = Date.now();
        try {
          const result = await handler(job.data ?? {}, deps);
          const status = result && typeof result === "object" && "status" in result ? (result as { status: unknown }).status : undefined;
          child.info({ ms: Date.now() - started, status }, "job done");
        } catch (err) {
          const message = safeMessage(err);
          errors.push(`${name}: ${message}`);
          child.error({ ms: Date.now() - started, error: message }, "job failed — pg-boss will retry per queue policy");
          throw err instanceof Error ? err : new Error(message);
        }
      }
    });
  }
  log.info({ queues: Object.values(QUEUES).length }, "queue consumers registered");

  if (cfg.WORKER_SCHEDULES_ENABLED) {
    for (const s of SCHEDULES) await b.schedule(s.queue, s.cron, {}, { tz: "UTC" });
    // Kick off once at start so a fresh deployment is alive immediately (singleton queues dedupe).
    for (const q of [QUEUES.providerHealth, QUEUES.sourceRefreshAll, QUEUES.metricsRollup, QUEUES.jobMonitor] as const) await b.send(q, {}, {});
    log.info({ schedules: SCHEDULES.map((s) => `${s.queue}@${s.cron}`) }, "schedules registered");
  } else {
    for (const s of SCHEDULES) await b.unschedule(s.queue).catch(() => {});
    log.info("schedules disabled (WORKER_SCHEDULES_ENABLED=false)");
  }

  const snapshot = () => buildSnapshot(b, errors, { bossStarted });
  const agentos = getAgentOSAdapter();
  const publish = async () => {
    try {
      await agentos.publishStatus(await snapshot());
    } catch (err) {
      log.warn({ error: safeMessage(err) }, "AgentOS status publish failed");
    }
  };
  void publish();
  timers.push(setInterval(() => void publish(), 60_000));

  const host = process.env.WORKER_BIND?.trim() || "127.0.0.1";
  const server: Server = await startHealthServer(
    {
      token: cfg.AGENTOS_SUPERVISION_TOKEN,
      startedAt,
      snapshot,
      pending: () => pendingItems(),
      enqueue: (q) => b.send(q, {}, {}),
      log: { warn: (o, m) => log.warn(o, m), info: (o, m) => log.info(o, m) },
      readiness: async () => {
        const ping = await pingDb();
        const migrated = ping.ok ? await migrationsApplied() : false;
        const uptimeMin = (Date.now() - startedAt) / 60_000;
        const scheduleFresh = !cfg.WORKER_SCHEDULES_ENABLED || uptimeMin < 20 || (lastScheduleTick !== null && Date.now() - lastScheduleTick < 20 * 60_000);
        return {
          ready: ping.ok && bossStarted && !stopping && migrated && scheduleFresh,
          checks: {
            database: ping.ok,
            databaseLatencyMs: ping.latencyMs,
            queue: bossStarted && !stopping,
            migrations: migrated,
            schedules: cfg.WORKER_SCHEDULES_ENABLED ? (scheduleFresh ? "fresh" : "stale") : "disabled",
            lastScheduleTick: lastScheduleTick ? new Date(lastScheduleTick).toISOString() : "never",
          },
        };
      },
    },
    { port: cfg.WORKER_HEALTH_PORT, host },
  );
  log.info({ host, port: cfg.WORKER_HEALTH_PORT, supervision: Boolean(cfg.AGENTOS_SUPERVISION_TOKEN), agentos: agentos.mode }, "worker ready");

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down gracefully");
    for (const t of timers) clearInterval(t);
    server.close();
    try {
      await b.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      log.warn({ error: safeMessage(err) }, "pg-boss stop failed");
    }
    await closeDb().catch(() => {});
    log.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ error: safeMessage(err) }, "worker failed to start");
  process.exit(1);
});
