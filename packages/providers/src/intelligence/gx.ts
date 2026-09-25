import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";

/** STUB — replaced by the real gx adapter (owner: integrations agent). */
export class GxProvider implements IntelligenceProvider {
  readonly family = "gx" as const;
  readonly paid = false;
  isConfigured(): boolean {
    return false;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "needs_configuration", detail: "Adapter not implemented yet", checkedAt: new Date().toISOString() };
  }
  supports(_task: IntelligenceTask): boolean {
    return false;
  }
  estimateCost(_req: IntelligenceRequest): number {
    return 0;
  }
  async complete<T>(_req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    throw new Error("gx adapter not implemented");
  }
}
