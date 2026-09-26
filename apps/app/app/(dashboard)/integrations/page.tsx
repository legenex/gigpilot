import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { Callout, SectionHeader, formatUsd } from "@gigpilot/ui";
import { PasteButton } from "@/components/actions/paste-button";
import { InboundWebhookPanel } from "@/components/integrations/inbound-webhook-panel";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { PageHeader } from "@/components/page-header";
import { getIntegrations } from "@/lib/queries/integrations";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Integrations" };

const GROUPS: { kind: "intelligence" | "creative" | "marketplace" | "orchestration"; title: string; meta: string }[] = [
  { kind: "intelligence", title: "Intelligence", meta: "reasoning, research and local compute — routed per task" },
  { kind: "creative", title: "Creative production", meta: "image & video generation — cheapest route that clears the quality bar" },
  { kind: "marketplace", title: "Opportunity sources", meta: "official APIs, feeds and your own notifications — never scraping" },
  { kind: "orchestration", title: "Orchestration", meta: "external supervision" },
];

export default async function IntegrationsPage() {
  const ctx = await requireSession();
  const data = await getIntegrations(ctx.tenantId);
  const connected = data.items.filter((i) => i.status === "connected").length;
  const attention = data.items.filter((i) => ["needs_configuration", "error", "degraded"].includes(i.status)).length;
  const paidEnabled = data.envBudget > 0 && data.tenantBudget > 0;
  const base = data.appUrl.replace(/\/$/, "");
  return (
    <div className="page">
      <PageHeader
        eyebrow="Integrations"
        title="Providers, sources and credentials"
        description={`${connected} connected · ${attention} need attention · missing credentials fall back to mock mode, never a crash`}
        actions={<PasteButton />}
      />
      <Callout tone={paidEnabled ? "warn" : "info"} className="mb-7" title={paidEnabled ? "Paid providers are live" : "Paid providers are off (test mode)"}>
        {paidEnabled
          ? `Paid calls are allowed up to ${formatUsd(data.tenantBudget, { cents: true })}/day for this workspace (server cap ${formatUsd(data.envBudget, { cents: true })}/day).`
          : `Paid providers are only called when both the server budget (PAID_PROVIDER_DAILY_BUDGET_USD, now ${formatUsd(data.envBudget)}) and your workspace daily paid limit (now ${formatUsd(data.tenantBudget)}, max ${formatUsd(data.paidCeilingUsd)} for this workspace) are above $0. Until then creative and reasoning run through mock providers at $0.`}
        <span className="mt-1 block text-fg-3" data-testid="credential-scope">
          {data.operator
            ? "Operator workspace: server-wide provider and marketplace credentials are available as a fallback."
            : "This workspace uses only credentials stored here (plus the shared, quota-limited local GX gateway). Server-wide keys are reserved for the operator."}
        </span>
      </Callout>
      <div className="flex flex-col gap-9">
        {GROUPS.map((g) => {
          const items = data.items.filter((i) => i.kind === g.kind);
          return (
            <section key={g.kind} aria-labelledby={`g-${g.kind}`}>
              <SectionHeader id={`g-${g.kind}`} title={g.title} meta={g.meta} />
              {g.kind === "marketplace" ? (
                <div className="mb-4">
                  <InboundWebhookPanel secret={data.inboundSecret} appUrl={base} slug={data.slug} canManage={ctx.role === "owner" || ctx.role === "admin"} />
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {items.map((it) => (
                  <IntegrationCard key={it.key} it={it} webhookUrl={base && data.slug ? `${base}/api/inbound/${it.key}?tenant=${data.slug}` : null} inboundSecretSet={Boolean(data.inboundSecret)} paidEnabled={paidEnabled} />
                ))}
                {g.kind === "orchestration" ? (
                  <article className="flex flex-col justify-center gap-2 rounded-md border border-dashed border-line-strong px-5 py-5" aria-label="Future providers">
                    <p className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                      <Plus className="size-4 text-fg-3" /> Future providers
                    </p>
                    <p className="text-xs leading-5 text-fg-3">
                      New models and marketplaces plug in behind the same adapters — IntelligenceProvider, CreativeProvider and SourceAdapter. Each declares its
                      capabilities, compliance rules and credentials; missing credentials degrade to mock mode automatically.
                    </p>
                    <p className="font-mono text-[11px] text-fg-3">voice · music · 3D · new marketplaces with official APIs</p>
                  </article>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
