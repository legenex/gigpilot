import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPERATIONAL_DEFAULTS } from "@gigpilot/config";
import type { ProviderHealth } from "@gigpilot/contracts";
import { boolEnv, envValue } from "../lib/config";
import { redactText, safeFetch, type FetchLike } from "../lib/http";
import type { AgentOSAdapter, AgentOSStatusSnapshot } from "../types";

/**
 * AgentOS adapter boundary (D7). AgentOS has no runtime supervision API today,
 * so GigPilot is supervised PULL-ONLY: the worker serves a token-protected
 * supervision API on 127.0.0.1:4712 (see ops/agentos/README.md), and this
 * adapter additionally drops a status snapshot where AgentOS tooling can read it.
 *
 * Modes (selected from env, first match wins):
 *  - "http" — FUTURE, off by default: requires AGENTOS_PUSH_ENABLED=1 AND
 *    AGENTOS_BASE_URL. POSTs the snapshot to
 *    `${AGENTOS_BASE_URL}/api/projects/gigpilot/status` (path UNCONFIRMED)
 *    with bearer AGENTOS_PUSH_TOKEN. Also writes the file when one is available.
 *  - "file" — atomically writes the snapshot JSON to AGENTOS_STATUS_FILE, or to
 *    /srv/projects/gigpilot/status/agentos.json when that directory exists and
 *    is writable (tmp file + rename; readers never see partial JSON).
 *  - "noop" — nothing configured/writable.
 */

export const DEFAULT_STATUS_FILE = "/srv/projects/gigpilot/status/agentos.json";

function writableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the status file path, or undefined when no writable location exists. */
export function resolveStatusFile(): { path?: string; reason?: string } {
  const configured = envValue("AGENTOS_STATUS_FILE");
  const candidate = configured ?? DEFAULT_STATUS_FILE;
  const dir = path.dirname(candidate);
  if (!path.isAbsolute(candidate)) return { reason: "AGENTOS_STATUS_FILE must be an absolute path" };
  if (!writableDir(dir)) return { reason: `${dir} does not exist or is not writable` };
  return { path: candidate };
}

function sanitize(snapshot: AgentOSStatusSnapshot): AgentOSStatusSnapshot {
  return {
    ...snapshot,
    service: "gigpilot",
    lastErrors: (snapshot.lastErrors ?? []).slice(0, 20).map((e) => ({ at: e.at, message: redactText(String(e.message)).slice(0, 500) })),
  };
}

/** A status snapshot counts as "published" only when written within this window. */
const FRESH_MS = OPERATIONAL_DEFAULTS.agentosStatusFreshMinutes * 60_000;

/** Honest connected detail: the snapshot is published pull-only; AgentOS itself has not registered GigPilot yet. */
export const AGENTOS_CONNECTED_DETAIL = "status snapshot published (pull-only); AgentOS registration pending";

/** mtime of the status file (ms) or null when it does not exist / cannot be read. */
function fileMtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

interface PublishState {
  lastPublishAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  publishes: number;
}

export class FileStatusAdapter implements AgentOSAdapter {
  readonly mode = "file" as const;
  private readonly state: PublishState = { publishes: 0 };

  constructor(readonly filePath: string) {}

  async publishStatus(snapshot: AgentOSStatusSnapshot): Promise<void> {
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(tmp, `${JSON.stringify(sanitize(snapshot), null, 2)}\n`, { mode: 0o640 });
      await rename(tmp, this.filePath);
      this.state.lastPublishAt = new Date().toISOString();
      this.state.publishes++;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.state.lastError = err instanceof Error ? err.message.slice(0, 200) : "write failed";
      this.state.lastErrorAt = new Date().toISOString();
      throw err;
    }
  }

  /**
   * `connected` ONLY when the status file on disk was written within the last
   * OPERATIONAL_DEFAULTS.agentosStatusFreshMinutes (5 min) — the file's mtime is the evidence,
   * so a health check in another process (dashboard) sees the worker's publishes. Otherwise
   * `needs_configuration`: nothing is being published for AgentOS to read.
   */
  async health(now: number = Date.now()): Promise<ProviderHealth> {
    const checkedAt = new Date(now).toISOString();
    const mtime = fileMtimeMs(this.filePath);
    const lastWriteAt = mtime === null ? null : new Date(mtime).toISOString();
    const meta = { mode: this.mode, file: this.filePath, lastWriteAt, lastPublishAt: this.state.lastPublishAt ?? null, publishes: this.state.publishes, lastError: this.state.lastError ?? null, supervisionApi: "pull-only (worker 127.0.0.1:4712)", registration: "pending" };
    if (this.state.lastError && (!this.state.lastPublishAt || (this.state.lastErrorAt ?? "") > this.state.lastPublishAt)) {
      return { status: "degraded", detail: `Status file write failing: ${this.state.lastError}`, checkedAt, meta };
    }
    if (mtime !== null && now - mtime <= FRESH_MS) {
      return { status: "connected", detail: `${AGENTOS_CONNECTED_DETAIL} — ${this.filePath} written ${lastWriteAt}.`, checkedAt, meta };
    }
    return {
      status: "needs_configuration",
      detail: mtime === null ? `No status snapshot published yet at ${this.filePath}; AgentOS registration pending.` : `Status snapshot at ${this.filePath} is stale (last written ${lastWriteAt}); AgentOS registration pending.`,
      checkedAt,
      meta,
    };
  }
}

export class HttpPushAdapter implements AgentOSAdapter {
  readonly mode = "http" as const;
  private readonly state: PublishState = { publishes: 0 };

  constructor(
    private readonly baseUrl: string,
    private readonly file?: FileStatusAdapter,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async publishStatus(snapshot: AgentOSStatusSnapshot): Promise<void> {
    if (this.file) await this.file.publishStatus(snapshot).catch(() => {});
    const token = envValue("AGENTOS_PUSH_TOKEN");
    try {
      const res = await safeFetch(
        `${this.baseUrl.replace(/\/+$/, "")}/api/projects/gigpilot/status`,
        { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(sanitize(snapshot)) },
        { timeoutMs: 10_000, retries: 1, idempotent: true, fetch: this.fetchImpl, redact: [token] },
      );
      if (!res.ok) throw new Error(`AgentOS returned HTTP ${res.status}`);
      this.state.lastPublishAt = new Date().toISOString();
      this.state.publishes++;
    } catch (err) {
      this.state.lastError = err instanceof Error ? redactText(err.message, [token]).slice(0, 200) : "push failed";
      this.state.lastErrorAt = new Date().toISOString();
      throw err;
    }
  }

  async health(now: number = Date.now()): Promise<ProviderHealth> {
    const checkedAt = new Date(now).toISOString();
    const meta = { mode: this.mode, baseUrl: this.baseUrl, file: this.file?.filePath ?? null, lastPublishAt: this.state.lastPublishAt ?? null, publishes: this.state.publishes, lastError: this.state.lastError ?? null, registration: "pending" };
    if (this.state.lastError && (!this.state.lastPublishAt || (this.state.lastErrorAt ?? "") > this.state.lastPublishAt)) return { status: "degraded", detail: `AgentOS push failing: ${this.state.lastError}`, checkedAt, meta };
    const last = this.state.lastPublishAt ? Date.parse(this.state.lastPublishAt) : null;
    if (last !== null && now - last <= FRESH_MS) return { status: "connected", detail: `${AGENTOS_CONNECTED_DETAIL} — pushed ${this.state.lastPublishAt} (experimental HTTP push).`, checkedAt, meta };
    if (this.file) {
      const fileHealth = await this.file.health(now);
      if (fileHealth.status === "connected") return { ...fileHealth, meta: { ...meta, ...(fileHealth.meta ?? {}) } };
    }
    return { status: "needs_configuration", detail: "No status snapshot pushed in the last 5 minutes; AgentOS registration pending.", checkedAt, meta };
  }
}

export class NoopAgentOSAdapter implements AgentOSAdapter {
  readonly mode = "noop" as const;
  constructor(private readonly reason = "no writable status location") {}
  async publishStatus(_snapshot: AgentOSStatusSnapshot): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    const token = Boolean(envValue("AGENTOS_SUPERVISION_TOKEN"));
    // No snapshot is published in noop mode, so this is never `connected` (even with the pull-only API token set).
    return {
      status: "needs_configuration",
      detail: token
        ? `Pull-only supervision API enabled (bearer token set), but no status snapshot is published: ${this.reason}. AgentOS registration pending.`
        : `Set AGENTOS_SUPERVISION_TOKEN to enable the pull-only supervision API; status snapshot disabled: ${this.reason}. AgentOS registration pending.`,
      checkedAt: new Date().toISOString(),
      meta: { mode: this.mode, supervisionTokenSet: token, registration: "pending" },
    };
  }
}

let cached: { key: string; adapter: AgentOSAdapter } | undefined;

export function getAgentOSAdapter(): AgentOSAdapter {
  const file = resolveStatusFile();
  const push = boolEnv("AGENTOS_PUSH_ENABLED") ? envValue("AGENTOS_BASE_URL") : undefined;
  const key = `${push ?? ""}|${file.path ?? ""}`;
  if (cached?.key === key) return cached.adapter;
  let adapter: AgentOSAdapter;
  const fileAdapter = file.path ? new FileStatusAdapter(file.path) : undefined;
  if (push && /^https?:\/\//i.test(push)) adapter = new HttpPushAdapter(push, fileAdapter);
  else if (fileAdapter) adapter = fileAdapter;
  else adapter = new NoopAgentOSAdapter(file.reason);
  cached = { key, adapter };
  return adapter;
}

/** Test helper. */
export function resetAgentOSAdapter(): void {
  cached = undefined;
}
