import type { SourceAdapter, SourceCapabilities } from "@gigpilot/contracts";
import { InboundOnlySource } from "../lib/inbound-source";

/**
 * Fiverr — no seller API; Fiverr's Terms of Service prohibit bots, scrapers
 * and automated access to the site. GigPilot ingests ONLY buyer-brief
 * notifications the owner forwards from their own inbox (signed inbound
 * webhook) or pastes in; the owner responds on Fiverr themselves.
 * See docs/research/marketplaces.md.
 *
 * Credentials: none (the inbound webhook is verified with the server secret
 * INBOUND_WEBHOOK_SECRET via lib/inbound.ts `verifyInboundSignature`).
 */
export class FiverrSource extends InboundOnlySource implements SourceAdapter {
  readonly key = "fiverr" as const;
  readonly name = "Fiverr";
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
      "Fiverr offers no seller API and its Terms prohibit bots, scrapers and automated access. GigPilot never scrapes Fiverr: forward your own buyer-brief notification emails or paste a brief, and reply on Fiverr yourself.",
    docsUrl: "https://www.fiverr.com/legal-portal/legal-terms/terms-of-service",
  };

  withTenant(_tenantId: string | null): FiverrSource {
    return this;
  }
}
