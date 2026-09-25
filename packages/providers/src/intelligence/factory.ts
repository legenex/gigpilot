import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";

/** STUB — replaced by the real factory adapter (owner: integrations agent). */
export class FactoryProvider implements IntelligenceProvider {
  readonly family = "factory" as const;
  readonly paid = true;
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
    throw new Error("factory adapter not implemented");
  }
}
