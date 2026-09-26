import type { Metadata } from "next";
import { APPLICATION_STATES, type ApplicationState } from "@gigpilot/contracts";
import { formatUsd } from "@gigpilot/ui";
import { ApplicationsView } from "@/components/applications/applications-view";
import { PageHeader } from "@/components/page-header";
import { getApplications } from "@/lib/queries/applications";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Applications" };

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const sp = await searchParams;
  const view = sp.view === "table" ? "table" : "board";
  const state = typeof sp.state === "string" && (APPLICATION_STATES as readonly string[]).includes(sp.state) ? (sp.state as ApplicationState) : null;
  const { apps, pendingProposals, counts } = await getApplications(ctx.tenantId);
  const open = apps.filter((a) => ["approved", "submitted", "client_response", "negotiating"].includes(a.status));
  const openValue = open.reduce((s, a) => s + (a.priceUsd ?? 0), 0);
  const decided = apps.filter((a) => a.status === "won" || a.status === "lost");
  const winRate = decided.length ? Math.round((apps.filter((a) => a.status === "won").length / decided.length) * 100) : null;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Applications"
        title="From approved proposal to signed work"
        description={`${open.length} open (${formatUsd(openValue)}) · ${pendingProposals.length} proposal${pendingProposals.length === 1 ? "" : "s"} awaiting approval · ${winRate === null ? "no decided applications yet" : `${winRate}% win rate on decided`}`}
      />
      <ApplicationsView apps={apps} pending={pendingProposals} counts={counts} view={view} stateFilter={state} />
    </div>
  );
}
