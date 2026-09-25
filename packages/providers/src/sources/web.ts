import type { ProviderHealth, RawOpportunity, SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";

/** STUB — replaced by the real Public web feeds adapter (owner: integrations agent). */
export class WebFeedSource implements SourceAdapter {
  readonly key = "web";
  readonly name = "Public web feeds";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "rss",
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
