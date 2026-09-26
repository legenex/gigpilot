import type { Metadata } from "next";
import { MarketLab } from "@/components/markets/market-lab";
import { PageHeader } from "@/components/page-header";
import { getMarkets } from "@/lib/queries/markets";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Market Lab" };

export default async function MarketsPage() {
  const ctx = await requireSession();
  const { markets, insights } = await getMarkets(ctx.tenantId);
  const enabled = markets.filter((m) => m.enabled);
  const perDay = enabled.reduce((s, m) => s + m.metrics.opportunitiesPerDay, 0);
  const best = [...enabled].sort((a, b) => b.metrics.avgProfitUsd - a.metrics.avgProfitUsd)[0];
  return (
    <div className="page">
      <PageHeader
        eyebrow="Market Lab"
        title="Where the Scout looks, and how hard"
        description={`${enabled.length} of ${markets.length} markets enabled · ~${perDay.toFixed(0)} opportunities/day across them${best ? ` · highest profit per job: ${best.name}` : ""}`}
      />
      <MarketLab markets={markets} insights={insights} />
    </div>
  );
}
