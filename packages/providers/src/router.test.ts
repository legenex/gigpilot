import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { IntelligenceFamily, IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";
import { MockIntelligenceProvider } from "./intelligence/mock";
import { ModelRouter } from "./router";
import type { ProviderCallContext } from "./types";

class FakeProvider implements IntelligenceProvider {
  calls = 0;
  lastTenant: string | undefined;
  constructor(
    readonly family: IntelligenceFamily,
    readonly paid: boolean,
    private readonly opts: { configured?: boolean; configuredFor?: (t: string | null) => boolean; cost?: number; fail?: string; data?: unknown; supports?: IntelligenceTask[] } = {},
  ) {}
  isConfigured(): boolean {
    return this.opts.configured ?? true;
  }
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return this.opts.configuredFor ? this.opts.configuredFor(tenantId) : this.isConfigured();
  }
  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "fake", checkedAt: new Date().toISOString() };
  }
  supports(task: IntelligenceTask): boolean {
    return this.opts.supports ? this.opts.supports.includes(task) : true;
  }
  estimateCost(): number {
    return this.opts.cost ?? 0;
  }
  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    this.calls++;
    this.lastTenant = req.context?.tenantId;
    if (this.opts.fail) throw new Error(this.opts.fail);
    const data = (this.opts.data ?? { answer: this.family }) as T;
    return { family: this.family, model: `${this.family}-model`, text: JSON.stringify(data), data, usage: { inputTokens: 10, outputTokens: 5, costUsd: this.opts.cost ?? 0, costSource: this.paid ? "provider" : "free" }, latencyMs: 3 };
  }
}

const schema = z.object({ answer: z.string() });
const req = (task: IntelligenceTask, extra: Partial<IntelligenceRequest<{ answer: string }>> = {}): IntelligenceRequest<{ answer: string }> => ({
  task,
  messages: [{ role: "user", content: "hello" }],
  schema,
  mockResult: () => ({ answer: "mock" }),
  ...extra,
});
const noPaid: ProviderCallContext = { tenantId: "t1", budget: { allowPaid: false, remainingPaidUsd: 0 }, preferLocalForCheapTasks: true };
const paid = (remaining: number): ProviderCallContext => ({ tenantId: "t1", budget: { allowPaid: true, remainingPaidUsd: remaining }, preferLocalForCheapTasks: true });

describe("ModelRouter", () => {
  it("routes cheap tasks gx → factory → mock, research grok → gx → mock, reasoning factory → gx → mock", () => {
    const r = new ModelRouter([new MockIntelligenceProvider()]);
    expect(r.routeFor("triage", noPaid)).toEqual(["gx", "factory", "mock"]);
    expect(r.routeFor("analyse_opportunity", { ...noPaid, preferLocalForCheapTasks: false })).toEqual(["factory", "gx", "mock"]);
    expect(r.routeFor("market_research", noPaid)).toEqual(["grok", "gx", "mock"]);
    expect(r.routeFor("proposal", noPaid)).toEqual(["factory", "gx", "mock"]);
  });

  it("uses the first eligible provider and passes the tenant in the request context", async () => {
    const gx = new FakeProvider("gx", false);
    const factory = new FakeProvider("factory", true, { cost: 0.01 });
    const r = new ModelRouter([gx, factory, new MockIntelligenceProvider()]);
    const res = await r.complete(req("triage"), paid(5));
    expect(res.family).toBe("gx");
    expect(res.paid).toBe(false);
    expect(res.fallbacks).toEqual([]);
    expect(gx.lastTenant).toBe("t1");
  });

  it("skips paid providers when paid spend is disabled or unaffordable, recording reasons", async () => {
    const factory = new FakeProvider("factory", true, { cost: 0.5 });
    const gx = new FakeProvider("gx", false, { configured: false });
    const r = new ModelRouter([factory, gx, new MockIntelligenceProvider()]);
    const res = await r.complete(req("proposal"), noPaid);
    expect(res.family).toBe("mock");
    expect(res.fallbacks.map((f) => f.family)).toEqual(["factory", "gx"]);
    expect(res.fallbacks[0]!.reason).toMatch(/paid spend disabled/);
    expect(res.fallbacks[1]!.reason).toBe("not configured");
    expect(factory.calls).toBe(0);

    const overBudget = await r.complete(req("proposal"), paid(0.1));
    expect(overBudget.family).toBe("mock");
    expect(overBudget.fallbacks[0]!.reason).toMatch(/exceeds remaining paid budget/);

    const overCap = await r.complete(req("proposal", { maxCostUsd: 0.2 }), paid(10));
    expect(overCap.fallbacks[0]!.reason).toMatch(/ceiling/);

    const allowed = await r.complete(req("proposal"), paid(10));
    expect(allowed.family).toBe("factory");
    expect(allowed.paid).toBe(true);
  });

  it("honours tenant-scoped configuration (isConfiguredFor) and the allowed-family policy", async () => {
    const gx = new FakeProvider("gx", false, { configured: false, configuredFor: (t) => t === "t1" });
    const r = new ModelRouter([gx, new MockIntelligenceProvider()]);
    expect((await r.complete(req("triage"), noPaid)).family).toBe("gx");
    expect((await r.complete(req("triage"), { ...noPaid, tenantId: "t2" })).family).toBe("mock");
    const blocked = await r.complete(req("triage"), { ...noPaid, allowedFamilies: ["factory"] });
    expect(blocked.family).toBe("mock");
    expect(blocked.fallbacks[0]!.reason).toMatch(/not allowed/);
  });

  it("falls through on provider errors and on schema-invalid output (defence in depth)", async () => {
    const gx = new FakeProvider("gx", false, { fail: "timeout after 180000ms" });
    const factory = new FakeProvider("factory", true, { data: { wrong: 1 } });
    const r = new ModelRouter([gx, factory, new MockIntelligenceProvider()]);
    const res = await r.complete(req("triage"), paid(10));
    expect(res.family).toBe("mock");
    expect(res.data).toEqual({ answer: "mock" });
    expect(res.fallbacks[0]!.reason).toMatch(/failed: timeout/);
    expect(res.fallbacks[1]!.reason).toMatch(/validation/);
  });

  it("redacts credentials echoed in provider errors", async () => {
    const gx = new FakeProvider("gx", false, { fail: "401 for Bearer sk-abcdef1234567890" });
    const r = new ModelRouter([gx, new MockIntelligenceProvider()]);
    const res = await r.complete(req("triage"), noPaid);
    expect(res.fallbacks[0]!.reason).not.toContain("sk-abcdef");
    expect(res.fallbacks[0]!.reason).toContain("[redacted]");
  });

  it("mock is deterministic, free, and refuses structured tasks without a mockResult", async () => {
    const r = new ModelRouter([new MockIntelligenceProvider()]);
    const a = await r.complete(req("summarise"), noPaid);
    const b = await r.complete(req("summarise"), noPaid);
    expect(a.data).toEqual(b.data);
    expect(a.model).toBe("mock-deterministic");
    expect(a.usage.costUsd).toBe(0);
    await expect(r.complete({ task: "summarise", messages: [], schema }, noPaid)).rejects.toThrow(/mockResult/);
  });
});
