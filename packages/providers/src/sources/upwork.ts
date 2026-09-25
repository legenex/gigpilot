import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";

/** STUB — replaced by the real Upwork adapter (owner: integrations agent). */
export class UpworkSource implements SourceAdapter {
  readonly key = "upwork";
  readonly name = "Upwork";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "api",
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
