import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";

/** STUB — replaced by the real Contra adapter (owner: integrations agent). */
export class ContraSource implements SourceAdapter {
  readonly key = "contra";
  readonly name = "Contra";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "manual",
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
