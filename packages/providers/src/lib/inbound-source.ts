import type { ProviderHealth, RawOpportunity, SourceCapabilities } from "@gigpilot/contracts";
import { envValue } from "./config";
import { parseInboundNotification, type InboundNotification } from "./inbound";

/**
 * Shared behaviour for marketplaces that have NO permitted API (Contra,
 * Fiverr): opportunities arrive only as the owner's own forwarded notification
 * emails (signed inbound webhook, INBOUND_WEBHOOK_SECRET) or manual paste.
 * `fetchOpportunities` never touches the network and always returns [] —
 * ingestion happens in the dashboard's webhook route via `parse()`.
 */
export abstract class InboundOnlySource {
  abstract readonly key: "contra" | "fiverr";
  abstract readonly name: string;
  abstract readonly capabilities: SourceCapabilities;

  isConfigured(): boolean {
    return Boolean(envValue("INBOUND_WEBHOOK_SECRET"));
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!envValue("INBOUND_WEBHOOK_SECRET")) {
      return {
        status: "needs_configuration",
        detail: `Set INBOUND_WEBHOOK_SECRET to accept forwarded ${this.name} notification emails. Manual paste works without it. No scraping, no API access.`,
        checkedAt,
        meta: { ingestion: ["manual"], webhookSigned: false },
      };
    }
    return {
      status: "connected",
      detail: `Ready: forward your ${this.name} notification emails to GigPilot's signed inbound webhook, or paste briefs manually.`,
      checkedAt,
      meta: { ingestion: ["email", "manual"], webhookSigned: true },
    };
  }

  async fetchOpportunities(_opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]> {
    return [];
  }

  /** Parse one forwarded notification for this marketplace. */
  parse(n: Omit<InboundNotification, "provider">): RawOpportunity | null {
    return parseInboundNotification({ ...n, provider: this.key });
  }
}
