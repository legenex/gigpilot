import type { Metadata } from "next";
import { PLATFORM_FEE_DEFAULTS } from "@gigpilot/config/defaults";
import { getDb, getTenantSettings, isOperatorTenant, paidSpendCeilingUsd } from "@gigpilot/db";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireSession();
  const [settings, operator] = await Promise.all([getTenantSettings(getDb(), ctx.tenantId), isOperatorTenant(getDb(), ctx.tenantId).catch(() => false)]);
  const envBudget = Number(process.env.PAID_PROVIDER_DAILY_BUDGET_USD ?? 0) || 0;
  const paidCeilingUsd = paidSpendCeilingUsd(operator);
  const feeKeys = Array.from(new Set([...Object.keys(PLATFORM_FEE_DEFAULTS), ...Object.keys(settings.economics.platformFees)]));
  return (
    <div className="page">
      <PageHeader
        eyebrow="Settings"
        title="Rules the agents work by"
        description={`${ctx.tenantName} · thresholds, economics, autonomy and spend guardrails · every change is validated and audited`}
      />
      <SettingsForm initial={settings} envBudgetUsd={envBudget} paidCeilingUsd={paidCeilingUsd} operator={operator} feeKeys={feeKeys} />
    </div>
  );
}
