import type { QueueName, QueuePayloads, SourceAdapter } from "@gigpilot/contracts";
import {
  getCreativeBroker,
  getIntelligenceRouter,
  getSourceAdapter,
  getStorage,
  type CreativeBroker,
  type IntelligenceRouter,
  type StorageAdapter,
} from "@gigpilot/providers";

/**
 * Dependencies injected into every agent handler. The worker wires a
 * pg-boss backed queue; tests wire a recording queue and drive the handlers
 * directly, which keeps the pipeline deterministic.
 */

export interface JobSendOptions {
  singletonKey?: string;
  startAfter?: number | string | Date;
  priority?: number;
  retryLimit?: number;
  expireInSeconds?: number;
}

export interface Enqueuer {
  send<Q extends QueueName>(name: Q, payload: QueuePayloads[Q], options?: JobSendOptions): Promise<string | null>;
}

export interface AgentLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface AgentDeps {
  queue: Enqueuer;
  log: AgentLogger;
  now(): Date;
  router?: IntelligenceRouter;
  broker?: CreativeBroker;
  storage?: StorageAdapter;
  sources?: (key: string) => SourceAdapter | undefined;
  /**
   * Aborted when this handler must stop: the queue job expired (pg-boss
   * `job.signal`) or the worker is shutting down. Passed to every provider call.
   */
  signal?: AbortSignal;
  /**
   * Aborted only on worker shutdown (SIGTERM). Lets handlers tell a resumable
   * interruption (step back to `ready`, attempt not consumed) from an expiry.
   */
  shutdown?: AbortSignal;
}

export const silentLogger: AgentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function routerOf(deps: AgentDeps): IntelligenceRouter {
  return deps.router ?? getIntelligenceRouter();
}
export function brokerOf(deps: AgentDeps): CreativeBroker {
  return deps.broker ?? getCreativeBroker();
}
export function storageOf(deps: AgentDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}
export function sourceOf(deps: AgentDeps, key: string): SourceAdapter | undefined {
  return deps.sources ? deps.sources(key) : getSourceAdapter(key);
}

/** Queue adapter over anything with a pg-boss compatible `send`. */
export function enqueuerFrom(boss: { send(name: string, data: object, options?: object): Promise<string | null> }): Enqueuer {
  return {
    send: (name, payload, options) => boss.send(name, payload as object, options ?? {}),
  };
}

export interface RecordedJob {
  name: QueueName;
  payload: unknown;
  options: JobSendOptions;
}

/** In-memory queue used by tests to capture and replay follow-up work. */
export class RecordingQueue implements Enqueuer {
  readonly jobs: RecordedJob[] = [];
  private readonly keys = new Set<string>();

  async send<Q extends QueueName>(name: Q, payload: QueuePayloads[Q], options: JobSendOptions = {}): Promise<string | null> {
    if (options.singletonKey) {
      const k = `${name}|${options.singletonKey}`;
      if (this.keys.has(k)) return null;
      this.keys.add(k);
    }
    this.jobs.push({ name, payload, options });
    return `${name}-${this.jobs.length}`;
  }

  /** Remove and return the next job (FIFO), releasing its singleton key. */
  shift(): RecordedJob | undefined {
    const job = this.jobs.shift();
    if (job?.options.singletonKey) this.keys.delete(`${job.name}|${job.options.singletonKey}`);
    return job;
  }

  take(name: QueueName): RecordedJob[] {
    const taken = this.jobs.filter((j) => j.name === name);
    for (const j of taken) {
      this.jobs.splice(this.jobs.indexOf(j), 1);
      if (j.options.singletonKey) this.keys.delete(`${j.name}|${j.options.singletonKey}`);
    }
    return taken;
  }
}
