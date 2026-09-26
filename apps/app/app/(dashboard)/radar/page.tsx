import type { Metadata } from "next";
import { PasteButton } from "@/components/actions/paste-button";
import { RefreshSourcesButton } from "@/components/actions/refresh-sources-button";
import { OpportunityPane } from "@/components/opportunity/detail";
import { PageHeader } from "@/components/page-header";
import { RadarWorkspace } from "@/components/radar/radar-workspace";
import { nowMs } from "@/lib/format";
import { getOpportunityDetail } from "@/lib/queries/opportunity";
import { getRadar, parseRadarFilters } from "@/lib/queries/radar";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Opportunity Radar" };

export default async function RadarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const sp = await searchParams;
  const filters = parseRadarFilters(sp);
  const detailP = filters.sel ? getOpportunityDetail(ctx.tenantId, filters.sel) : Promise.resolve(null);
  let data = await getRadar(ctx.tenantId, filters);
  // No explicit view and nothing pursue-worthy: open on "All" instead of an empty queue.
  if (!sp.view && !filters.status && data.counts.pursue === 0 && data.counts.all > 0) {
    filters.view = "all";
    filters.sort = typeof sp.sort === "string" ? filters.sort : "age";
    filters.dir = typeof sp.dir === "string" ? filters.dir : "asc";
    data = await getRadar(ctx.tenantId, filters);
  }
  const detail = await detailP;
  const sources = data.sources.length;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Opportunity Radar"
        title="Every opportunity, priced before you look"
        description={`${data.counts.all} opportunities from ${sources} source${sources === 1 ? "" : "s"} · ${data.counts.pursue} clear your profit and margin gates · deterministic economics, no invented prices`}
        actions={
          <>
            <PasteButton />
            <RefreshSourcesButton variant="primary" />
          </>
        }
      />
      <RadarWorkspace
        rows={data.rows}
        total={data.total}
        counts={data.counts}
        markets={data.markets}
        sources={data.sources}
        filters={filters}
        nowMs={nowMs()}
        pane={detail ? <OpportunityPane d={detail} /> : filters.sel ? <p className="text-[13px] text-fg-3">This opportunity no longer exists or belongs to another workspace.</p> : null}
      />
    </div>
  );
}
