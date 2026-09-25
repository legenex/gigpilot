import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";

/** STUB — replaced by the deterministic mock provider (owner: agent-system agent). */
export class MockIntelligenceProvider implements IntelligenceProvider {
  readonly family = "mock" as const;
  readonly paid = false;
  isConfigured(): boolean {
    return true;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "mock", detail: "Deterministic test mode", checkedAt: new Date().toISOString() };
  }
  supports(_task: IntelligenceTask): boolean {
    return true;
  }
  estimateCost(): number {
    return 0;
  }
  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    const data = req.mockResult ? await req.mockResult() : undefined;
    return { family: "mock", model: "mock-deterministic", text: JSON.stringify(data ?? {}), data, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: "free" }, latencyMs: 1 };
  }
}
