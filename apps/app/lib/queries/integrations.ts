import "server-only";
import { INTEGRATIONS, SOURCE_KEYS, type IntegrationStatus, type SourceCapabilities } from "@gigpilot/contracts";
import { eq, getDb, getTenantSettings, listTenantSecretHints, providerIntegration, sourceIntegration, tenant } from "@gigpilot/db";
import { getSourceAdapter } from "@gigpilot/providers";

export interface IntegrationView {
  key: string;
  name: string;
  kind: "intelligence" | "creative" | "marketplace" | "orchestration";
  description: string;
  envVars: string[];
  secretFields: { name: string; label: string; hint: string | null; updatedAt: string | null }[];
  docsUrl: string | null;
  paid: boolean;
  status: IntegrationStatus;
  statusDetail: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
  enabled: boolean;
  isSource: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  capabilities: SourceCapabilities | null;
  meta: Record<string, unknown> | null;
}

export async function getIntegrations(tenantId: string) {
  const db = getDb();
  const [providers, sources, hints, t, settings] = await Promise.all([
    db.select().from(providerIntegration).where(eq(providerIntegration.tenantId, tenantId)),
    db.select().from(sourceIntegration).where(eq(sourceIntegration.tenantId, tenantId)),
    listTenantSecretHints(db, tenantId),
    db.select({ slug: tenant.slug }).from(tenant).where(eq(tenant.id, tenantId)).limit(1),
    getTenantSettings(db, tenantId),
  ]);
  const pMap = new Map(providers.map((p) => [p.providerKey, p]));
  const sMap = new Map(sources.map((s) => [s.sourceKey, s]));
  const items: IntegrationView[] = INTEGRATIONS.map((d) => {
    const isSource = (SOURCE_KEYS as readonly string[]).includes(d.key);
    const p = pMap.get(d.key);
    const s = sMap.get(d.key);
    return {
      key: d.key,
      name: d.name,
      kind: d.kind,
      description: d.description,
      envVars: d.envVars,
      secretFields: d.secretFields.map((f) => {
        const h = hints.find((x) => x.providerKey === d.key && x.name === f.name);
        return { name: f.name, label: f.label, hint: h?.hint ?? null, updatedAt: h ? h.updatedAt.toISOString() : null };
      }),
      docsUrl: d.docsUrl ?? null,
      paid: d.paid,
      status: (isSource ? s?.status : p?.status) ?? "needs_configuration",
      statusDetail: (isSource ? s?.statusDetail : p?.statusDetail) ?? null,
      latencyMs: isSource ? null : (p?.latencyMs ?? null),
      checkedAt: isSource ? (s?.updatedAt?.toISOString() ?? null) : (p?.lastCheckAt?.toISOString() ?? null),
      enabled: isSource ? Boolean(s?.enabled) : (p?.enabled ?? true),
      isSource,
      lastSyncAt: s?.lastSyncAt?.toISOString() ?? null,
      lastError: s?.lastError ?? null,
      capabilities: isSource ? (getSourceAdapter(d.key)?.capabilities ?? null) : null,
      meta: (p?.meta as Record<string, unknown> | null) ?? null,
    };
  });
  return {
    items,
    slug: t[0]?.slug ?? "",
    appUrl: process.env.APP_URL ?? "",
    inboundSecretSet: Boolean(process.env.INBOUND_WEBHOOK_SECRET?.trim()),
    envBudget: Number(process.env.PAID_PROVIDER_DAILY_BUDGET_USD ?? 0) || 0,
    tenantBudget: settings.limits.dailyPaidSpendLimitUsd,
  };
}
