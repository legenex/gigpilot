import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATIONS } from "@gigpilot/contracts";
import { FileStatusAdapter, getAgentOSAdapter, resetAgentOSAdapter } from "./agentos";
import { checkIntegration } from "./health";
import { resetWebFeedCache } from "./sources/web";
import { setTenantSecretLookup } from "./lib/credentials";
import { CLEAR_PROVIDER_ENV, jsonResponse, setEnv } from "./lib/testing";
import type { AgentOSStatusSnapshot } from "./types";

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, AGENTOS_STATUS_FILE: "/nonexistent-gigpilot-dir/agentos.json", FACTORY_DROID_BIN: "droid-definitely-not-installed-xyz" });
  resetAgentOSAdapter();
});
afterEach(() => {
  restore();
  setTenantSecretLookup(null);
  vi.unstubAllGlobals();
});

describe("checkIntegration", () => {
  it("returns a secret-free status for every registry key with nothing configured, without network calls (except one cached feed reachability check)", async () => {
    resetWebFeedCache();
    const fetchSpy = vi.fn(async (_url: string) => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const expected: Record<string, string> = {
      factory: "needs_configuration",
      gx: "needs_configuration",
      grok: "needs_configuration",
      kie: "needs_configuration",
      higgsfield: "needs_configuration",
      upwork: "needs_configuration",
      freelancer: "needs_configuration",
      contra: "needs_configuration",
      fiverr: "needs_configuration",
      // Web feeds report a REAL signal: the (failed) cached reachability check → degraded, never a hopeful "connected".
      web: "degraded",
      direct: "connected",
      mock: "mock",
      agentos: "needs_configuration",
    };
    for (const i of INTEGRATIONS) {
      const h = await checkIntegration(i.key, null);
      expect(h.status, i.key).toBe(expected[i.key]);
      expect(h.checkedAt).toMatch(/^\d{4}-/);
      expect(typeof h.latencyMs).toBe("number");
    }
    // Only the web feeds' single HEAD reachability check touched the network (cached ≥ 60 min).
    expect(fetchSpy.mock.calls.map((c) => new URL(String(c[0])).hostname)).toEqual(["weworkremotely.com"]);
    expect(Object.keys(expected).sort()).toEqual(INTEGRATIONS.map((i) => i.key).sort());
  });

  it("honours tenant-stored secrets", async () => {
    setEnv({ GX_BASE_URL: "http://gx.test/v1" });
    setTenantSecretLookup(async (tenantId, provider, name) => (tenantId === "tenant-a" && provider === "gx" && name === "GX_API_KEY" ? "tenant-secret-key" : undefined));
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tenant-secret-key");
      return jsonResponse({ data: [{ id: "gx-mini" }, { id: "gx-code" }] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const h = await checkIntegration("gx", "tenant-a");
    expect(h.status).toBe("connected");
    expect(JSON.stringify(h)).not.toContain("tenant-secret-key");
    expect((await checkIntegration("gx", "tenant-b")).status).toBe("needs_configuration");
  });

  it("reports unknown keys as errors and never throws", async () => {
    expect((await checkIntegration("nope", null)).status).toBe("error");
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED Bearer should-not-appear-123");
    });
    const r = setEnv({ XAI_API_KEY: "xai-live-key-9999999999" });
    const h = await checkIntegration("grok", null);
    expect(h.status).toBe("unavailable");
    expect(h.detail).not.toContain("xai-live-key-9999999999");
    expect(h.detail).not.toContain("should-not-appear-123");
    r();
  });
});

describe("AgentOS adapter", () => {
  const snapshot: AgentOSStatusSnapshot = {
    service: "gigpilot",
    version: "0.1.0",
    generatedAt: "2026-09-26T00:00:00Z",
    health: "ok",
    queues: { analyse: { queued: 1, active: 0, failed: 0 } },
    pending: { approvals: 2, activeJobs: 1, awaitingFinalApproval: 0, failedStepsLast24h: 0 },
    lastErrors: [{ at: "2026-09-26T00:00:00Z", message: "call failed with Authorization: Bearer abcdefghijklmnop" }],
  };

  it("is noop when no writable status directory exists — never connected, even with the supervision token", async () => {
    const a = getAgentOSAdapter();
    expect(a.mode).toBe("noop");
    await a.publishStatus(snapshot);
    const h = await a.health();
    expect(h.meta?.mode).toBe("noop");
    const r = setEnv({ AGENTOS_SUPERVISION_TOKEN: "test-token-placeholder" });
    expect((await a.health()).status).toBe("needs_configuration");
    r();
  });

  it("is connected only while the status file was written in the last 5 minutes (pull-only, registration pending)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-agentos-fresh-"));
    try {
      const file = path.join(dir, "agentos.json");
      const a = new FileStatusAdapter(file);
      expect((await a.health()).status).toBe("needs_configuration"); // nothing published yet
      await a.publishStatus(snapshot);
      const fresh = await a.health();
      expect(fresh.status).toBe("connected");
      expect(fresh.detail).toContain("status snapshot published (pull-only); AgentOS registration pending");
      const stale = await a.health(Date.now() + 6 * 60_000);
      expect(stale.status).toBe("needs_configuration");
      expect(stale.detail).toMatch(/stale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the snapshot atomically (redacted) and reports the last publish time", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-agentos-"));
    try {
      setEnv({ AGENTOS_STATUS_FILE: path.join(dir, "agentos.json") });
      resetAgentOSAdapter();
      const a = getAgentOSAdapter();
      expect(a.mode).toBe("file");
      await a.publishStatus(snapshot);
      const written = JSON.parse(readFileSync(path.join(dir, "agentos.json"), "utf8"));
      expect(written.pending.approvals).toBe(2);
      expect(written.lastErrors[0].message).not.toContain("abcdefghijklmnop");
      expect(readdirSync(dir)).toEqual(["agentos.json"]);
      const h = await a.health();
      expect(h.status).toBe("connected");
      expect(h.meta?.lastPublishAt).toBeTruthy();
      expect(getAgentOSAdapter()).toBe(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces write failures as degraded", async () => {
    const a = new FileStatusAdapter("/nonexistent-gigpilot-dir/x/agentos.json");
    await expect(a.publishStatus(snapshot)).rejects.toBeTruthy();
    expect((await a.health()).status).toBe("degraded");
  });
});
