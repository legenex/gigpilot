import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";

/** STUB — replaced by the real Demo marketplace adapter (owner: integrations agent). */
export class MockSource implements SourceAdapter {
  readonly key = "mock";
  readonly name = "Demo marketplace";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "mock",
    backgroundPollingAllowed: false,
    minPollIntervalMinutes: 60,
    maxCacheTtlHours: null,
    compliance: "Not implemented yet.",
  };
  isConfigured(): boolean {
    return false;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "needs_configuration", detail: "Adapter not implemented yet", checkedAt: new Date().toISOString() };
  }
  async fetchOpportunities(): Promise<RawOpportunity[]> {
    return [];
  }
}
