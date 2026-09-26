import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn, formatUsd } from "@gigpilot/ui";
import { fmtDate } from "@/lib/format";
import { sourceName } from "@/lib/labels";
import type { OpportunityDetail } from "@/lib/queries/opportunity";
import { DecisionPanel } from "./decision-panel";
import { ProposalPanel, type ProposalView } from "./proposal-panel";
import { BriefSection, EconomicsReceipt, Gates, KeyNumbers, OppHeader, PlanSection, RationaleSection, RisksSection, ScopeSection, Section } from "./sections";

function proposalView(d: OpportunityDetail): ProposalView | null {
  const p = d.currentProposal;
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    headline: p.headline,
    coverLetter: p.coverLetter,
    scope: p.scope,
    priceUsd: p.priceUsd,
    timelineDays: p.timelineDays,
    assumptions: p.assumptions,
    questions: p.questions,
    provider: p.provider,
    model: p.model,
    version: p.version,
    approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
  };
}

function decisionProps(d: OpportunityDetail) {
  return {
    oppId: d.opp.id,
    status: d.opp.status,
    recommendation: d.opp.recommendation,
    estimateComplete: d.opp.estimateComplete,
    proposalStatus: d.currentProposal?.status ?? null,
    applicationStatus: d.application?.status ?? null,
    jobId: d.job?.id ?? null,
  };
}

function showProposal(d: OpportunityDetail) {
  return Boolean(d.currentProposal) || ["pursuing", "applied", "won", "lost"].includes(d.opp.status);
}

function submissionCopy(d: OpportunityDetail, src: string): string {
  if (d.opp.sourceKey === "mock") return "Demo marketplace submission — simulated after your approval; nothing leaves GigPilot";
  return d.autoSubmit ? `Automatic via the official ${src} API, after your approval` : `Manual — you submit on ${src}; GigPilot prepares the text`;
}

/** Secondary numbers that the Radar table drops below 1536px live in the pane. */
function PaneFacts({ d }: { d: OpportunityDetail }) {
  const e = d.estimate?.breakdown;
  const items: [string, string][] = [
    ["Est. cost", e ? formatUsd(e.totalCostUsd - e.platformFeesUsd) : "—"],
    ["Platform fees", e ? formatUsd(e.platformFeesUsd) : "—"],
    ["Deadline", d.opp.deadlineAt ? fmtDate(d.opp.deadlineAt) : "—"],
    ["Posted", fmtDate(d.opp.postedAt ?? d.opp.createdAt)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[11px] text-fg-3">{k}</dt>
          <dd className="font-mono text-[12px] tabular text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Full page: main narrative column + sticky decision rail. */
export function OpportunityPage({ d }: { d: OpportunityDetail }) {
  const src = sourceName(d.opp.sourceKey);
  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-6">
        <OppHeader d={d} />
        <KeyNumbers d={d} />
        <BriefSection d={d} />
        <ScopeSection d={d} />
        <PlanSection d={d} />
        <EconomicsReceipt e={d.estimate?.breakdown ?? null} sourceKey={d.opp.sourceKey} />
        <RisksSection d={d} />
        <Section n="06" title="Proposal" meta={d.currentProposal ? "editable until approved" : undefined} id="proposal">
          <ProposalPanel proposal={proposalView(d)} oppId={d.opp.id} oppStatus={d.opp.status} sourceName={src} autoSubmit={d.autoSubmit} compliance={d.capabilities?.compliance ?? null} />
        </Section>
        <RationaleSection d={d} withEvents />
      </div>

      <aside className="xl:sticky xl:top-5 xl:self-start" aria-label="Decision">
        <div className="rounded-md bg-surface-1 p-4 ring-1 ring-inset ring-line">
          <p className="eyebrow mb-3">Decision</p>
          <Gates gates={d.score?.gates ?? null} settings={d.settings} estimate={d.estimate?.breakdown ?? null} />
          <div className="mt-4 border-t border-line pt-4">
            <DecisionPanel {...decisionProps(d)} layout="rail" />
          </div>
          {d.currentProposal?.status === "awaiting_approval" ? (
            <Link href="#proposal" className="mt-4 flex items-center justify-between rounded-sm bg-surface-2 px-3 py-2 text-xs text-fg-2 ring-1 ring-inset ring-line-strong hover:text-fg">
              <span className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                Proposal at {formatUsd(d.currentProposal.priceUsd)} awaits approval
              </span>
              <span aria-hidden>↓</span>
            </Link>
          ) : null}
        </div>
        <dl className="mt-4 space-y-3 px-1 text-xs">
          <div>
            <dt className="eyebrow mb-0.5">Submission</dt>
            <dd className="text-fg-2">{submissionCopy(d, src)}</dd>
          </div>
          {d.capabilities ? (
            <div>
              <dt className="eyebrow mb-0.5">Source policy</dt>
              <dd className="leading-5 text-fg-2">{d.capabilities.compliance}</dd>
            </div>
          ) : null}
          <div>
            <dt className="eyebrow mb-0.5">Opportunity ID</dt>
            <dd className="break-all font-mono text-[11px] text-fg-3">{d.opp.id}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

/** Radar side pane: one column, decision first, then the analysis essentials. */
export function OpportunityPane({ d }: { d: OpportunityDetail }) {
  const src = sourceName(d.opp.sourceKey);
  return (
    <div className="flex flex-col gap-5">
      <OppHeader d={d} size="pane" />
      <KeyNumbers d={d} variant="pane" />
      <PaneFacts d={d} />
      <div className={cn("rounded-md bg-surface-1 p-3.5 ring-1 ring-inset ring-line")}>
        <Gates gates={d.score?.gates ?? null} settings={d.settings} estimate={d.estimate?.breakdown ?? null} />
        <div className="mt-3 border-t border-line pt-3">
          <DecisionPanel {...decisionProps(d)} layout="pane" />
        </div>
      </div>
      {showProposal(d) ? (
        <Section title="Proposal" id="pane-proposal">
          <ProposalPanel proposal={proposalView(d)} oppId={d.opp.id} oppStatus={d.opp.status} sourceName={src} autoSubmit={d.autoSubmit} compliance={d.capabilities?.compliance ?? null} compact />
        </Section>
      ) : null}
      <BriefSection d={d} n="01" clamp />
      <ScopeSection d={d} n="02" />
      <PlanSection d={d} n="03" compact />
      <EconomicsReceipt e={d.estimate?.breakdown ?? null} n="04" sourceKey={d.opp.sourceKey} compact />
      <RisksSection d={d} n="05" />
      <RationaleSection d={d} n="06" />
      <Link
        href={`/radar/${d.opp.id}`}
        data-testid="opp-open-full"
        className="flex items-center justify-center gap-1.5 rounded-sm py-2.5 text-[13px] text-fg-2 ring-1 ring-inset ring-line hover:bg-surface-1 hover:text-fg"
      >
        Open full analysis <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}
