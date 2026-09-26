import type { SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";
import { InboundOnlySource } from "../lib/inbound-source";

/**
 * Contra — no public API; Contra's Terms prohibit bots, crawlers and other
 * automated access. GigPilot therefore ingests ONLY what the owner forwards
 * from their own inbox (signed inbound webhook) or pastes in, and the owner
 * applies on Contra themselves. See docs/research/marketplaces.md.
 *
 * Credentials: none (the inbound webhook is verified with the server secret
 * INBOUND_WEBHOOK_SECRET via lib/inbound.ts `verifyInboundSignature`).
 */
export class ContraSource extends InboundOnlySource implements SourceAdapter {
  readonly key = "contra" as const;
  readonly name = "Contra";
  readonly capabilities: SourceCapabilities = {
    canSearch: false,
    canSubmit: false,
    submitRequiresHumanConfirm: true,
    requiresUserOAuth: false,
    ingestionMode: "email",
    backgroundPollingAllowed: false,
    minPollIntervalMinutes: 0,
    maxCacheTtlHours: null,
    compliance:
      "Contra has no public API and its Terms prohibit bots, crawlers and automated access. GigPilot never scrapes Contra: forward your own Contra notification emails or paste a brief, and apply on Contra yourself.",
    docsUrl: "https://contra.com/terms",
  };

  withTenant(_tenantId: string | null): ContraSource {
    return this;
  }
}
