import { PgBoss, type SendOptions, type Queue } from "pg-boss";
import { QUEUES, type QueueName, type QueuePayloads } from "@gigpilot/contracts";

/**
 * Durable PostgreSQL-backed job queue (pg-boss). Background work survives
 * process restarts; retries are recorded by pg-boss and mirrored into
 * agent_run rows by the worker so history is never overwritten.
 */

type QueueOptions = Omit<Queue, "name">;

/** Queue policies: `stately` = at most one queued + one active per singletonKey. */
export const QUEUE_CONFIG: Record<QueueName, QueueOptions> = {
  [QUEUES.sourceRefresh]: { policy: "stately", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.sourceRefreshAll]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.opportunityAnalyse]: { policy: "stately", retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.opportunityRefine]: { policy: "stately", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.opportunityExpire]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.proposalGenerate]: { policy: "stately", retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.applicationSubmit]: { policy: "exclusive", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.applicationAward]: { policy: "exclusive", retryLimit: 2, retryDelay: 10, expireInSeconds: 300 },
  [QUEUES.jobPlan]: { policy: "exclusive", retryLimit: 3, retryDelay: 20, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.workflowTick]: { policy: "stately", retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.stepExecute]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 1800 },
  [QUEUES.deliveryPrepare]: { policy: "exclusive", retryLimit: 3, retryDelay: 20, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.marketResearch]: { policy: "stately", retryLimit: 2, retryDelay: 300, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.marketResearchAll]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.providerHealth]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.jobMonitor]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.notificationsDispatch]: { policy: "singleton", retryLimit: 1, expireInSeconds: 300 },
  [QUEUES.metricsRollup]: { policy: "singleton", retryLimit: 1, expireInSeconds: 600 },
};

interface BossGlobal {
  __gigpilotBoss?: Promise<PgBoss>;
}
const g = globalThis as unknown as BossGlobal;

export async function createBoss(opts: { max?: number; supervise?: boolean; schedule?: boolean } = {}): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL ?? "postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot",
    schema: "pgboss",
    max: opts.max ?? 4,
    application_name: `${process.env.GIGPILOT_SERVICE ?? "gigpilot"}-queue`,
    supervise: opts.supervise ?? false,
    schedule: opts.schedule ?? false,
  });
  boss.on("error", (err: unknown) => {
    const e = err as { message?: unknown; code?: unknown; name?: unknown } | null;
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : e && typeof e === "object"
          ? String(e.message ?? e.code ?? e.name ?? JSON.stringify(e).slice(0, 300))
          : String(err);
    console.error(JSON.stringify({ level: "error", msg: "queue error", error: detail }));
  });
  await boss.start();
  await ensureQueues(boss);
  return boss;
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of Object.entries(QUEUE_CONFIG)) {
    await boss.createQueue(name, options);
  }
}

/**
 * Lightweight producer for web processes (dashboard server actions). No
 * supervision or scheduling — the worker owns those.
 */
export function getProducer(): Promise<PgBoss> {
  if (!g.__gigpilotBoss) {
    g.__gigpilotBoss = createBoss({ max: 2, supervise: false, schedule: false }).catch((err) => {
      g.__gigpilotBoss = undefined;
      throw err;
    });
  }
  return g.__gigpilotBoss;
}

export async function enqueue<Q extends QueueName>(
  name: Q,
  payload: QueuePayloads[Q],
  options: SendOptions & { boss?: PgBoss } = {},
): Promise<string | null> {
  const { boss: provided, ...sendOptions } = options;
  const boss = provided ?? (await getProducer());
  return boss.send(name, payload as object, sendOptions);
}
