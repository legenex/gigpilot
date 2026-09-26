import type { ProviderHealth, RawOpportunity, SourceCapabilities } from "@gigpilot/contracts";
import { resolveTenantOnlyCredential } from "./credentials";
import { parseInboundNotification, type InboundNotification } from "./inbound";

/** Where each workspace's inbound webhook secret is stored (encrypted, per tenant). */
export const INBOUND_SECRET_PROVIDER_KEY = "inbound";
export const INBOUND_SECRET_NAME = "INBOUND_WEBHOOK_SECRET";

/**
 * Shared behaviour for marketplaces that have NO permitted API (Contra,
 * Fiverr): opportunities arrive only as the owner's own forwarded notification
 * emails (signed inbound webhook, per-workspace secret generated in
 * Integrations) or manual paste. `fetchOpportunities` never touches the
 * network and always returns [] — ingestion happens in the dashboard's
 * webhook route via `parse()`.
 */
export abstract class InboundOnlySource {
  abstract readonly key: "contra" | "fiverr";
  abstract readonly name: string;
  abstract readonly capabilities: SourceCapabilities;
  protected boundTenantId: string | null = null;

  /** No server-level configuration exists: the signed webhook needs a per-workspace secret. Manual paste always works. */
  isConfigured(): boolean {
    return false;
  }

  /** True when the workspace has generated its inbound webhook secret. */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(await resolveTenantOnlyCredential(INBOUND_SECRET_PROVIDER_KEY, INBOUND_SECRET_NAME, tenantId ?? this.boundTenantId));
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const secret = await resolveTenantOnlyCredential(INBOUND_SECRET_PROVIDER_KEY, INBOUND_SECRET_NAME, this.boundTenantId);
    if (!secret) {
      return {
        status: "needs_configuration",
        detail: `Generate this workspace's inbound webhook secret (Integrations → Inbound webhook) to accept forwarded ${this.name} notification emails. Manual paste works without it. No scraping, no API access.`,
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
