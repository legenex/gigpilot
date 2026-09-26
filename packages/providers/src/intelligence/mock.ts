import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";

export const MOCK_MODEL = "mock-deterministic";

export class MockResultRequiredError extends Error {
  constructor(schemaName: string | undefined, task: IntelligenceTask) {
    super(
      `Mock intelligence cannot answer structured task "${task}"${schemaName ? ` (${schemaName})` : ""} without a deterministic mockResult — every agent must supply one`,
    );
    this.name = "MockResultRequiredError";
  }
}

/** Rough token estimate (≈4 chars/token) so run records stay informative in mock mode. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic, zero-cost terminal fallback. It never calls a network and
 * answers with the agent-supplied `mockResult` (a deterministic heuristic),
 * so test/demo mode produces stable, realistic outputs.
 */
export class MockIntelligenceProvider implements IntelligenceProvider {
  readonly family = "mock" as const;
  readonly paid = false;

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: "mock",
      detail: "Deterministic test mode — heuristic outputs, no network, $0",
      checkedAt: new Date().toISOString(),
      meta: { model: MOCK_MODEL },
    };
  }

  supports(_task: IntelligenceTask): boolean {
    return true;
  }

  estimateCost(): number {
    return 0;
  }

  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    const started = Date.now();
    let data: T | undefined;
    if (req.mockResult) {
      data = await req.mockResult();
    } else if (req.schema) {
      throw new MockResultRequiredError(req.schemaName, req.task);
    }
    const text = typeof data === "string" ? data : JSON.stringify(data ?? {});
    const prompt = req.messages.map((m) => m.content).join("\n");
    return {
      family: "mock",
      model: MOCK_MODEL,
      text,
      data,
      usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(text), costUsd: 0, costSource: "free" },
      latencyMs: Math.max(1, Date.now() - started),
    };
  }
}
