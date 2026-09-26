import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CirclePause, SquareKanban } from "lucide-react";
import { JOB_STATES, type JobState } from "@gigpilot/contracts";
import { BarMeter, Button, DataTable, EmptyState, StatusDot, TBody, TD, TH, THead, cn, formatUsd } from "@gigpilot/ui";
import { ClickableRow } from "@/components/clickable-row";
import { PageHeader } from "@/components/page-header";
import { RelTime } from "@/components/rel-time";
import { JOB_META, SOURCE_SHORT } from "@/lib/labels";
import { pausedStepsSummary } from "@/lib/job-blockers";
import { listJobs, type JobRow } from "@/lib/queries/jobs";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Jobs" };

const PIPELINE: JobState[] = ["intake", "planning", "awaiting_inputs", "ready", "executing", "qa", "repairing", "awaiting_final_approval", "delivered", "closed"];

/** What the owner must do for a job, or null when agents can proceed on their own. */
function ownerAction(j: JobRow): { label: string; detail: string } | null {
  if (j.status === "awaiting_inputs") return { label: "Confirm inputs", detail: "waiting for your go-ahead to start production" };
  if (j.ownerBlocked > 0) {
    const onlyBudget = j.blockReasons.length === 1 && j.blockReasons[0] === "budget";
    return { label: onlyBudget ? "Raise spend limit" : "Authorise attempt", detail: pausedStepsSummary(j.ownerBlocked, j.blockReasons) };
  }
  return null;
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const sp = await searchParams;
  const state = typeof sp.state === "string" && (JOB_STATES as readonly string[]).includes(sp.state) ? (sp.state as JobState) : null;
  const { jobs, counts } = await listJobs(ctx.tenantId);
  const shown = state ? jobs.filter((j) => j.status === state) : jobs;
  const active = jobs.filter((j) => !["delivered", "closed", "cancelled"].includes(j.status));
  const inProd = active.reduce((s, j) => s + j.priceUsd, 0);
  const waiting = active.map((j) => ({ j, a: ownerAction(j) })).filter((x): x is { j: JobRow; a: { label: string; detail: string } } => x.a !== null);
  return (
    <div className="page">
      <PageHeader
        eyebrow="Jobs"
        title="Won work, planned and produced"
        description={`${active.length} active (${formatUsd(inProd)} contract value) · ${counts.awaiting_final_approval} awaiting your final approval · every job runs inside its spend limit`}
      />
      {waiting.length ? (
        <section aria-labelledby="jobs-waiting-title" className="relative mb-5 overflow-hidden rounded-md ring-1 ring-inset ring-line" data-testid="jobs-needs-you">
          <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
          <h2 id="jobs-waiting-title" className="flex items-center gap-2 px-4 pb-1.5 pt-2.5 text-[13px] font-semibold text-fg">
            <CirclePause className="size-4 text-accent-hi" strokeWidth={1.75} />
            {waiting.length} job{waiting.length === 1 ? " is" : "s are"} paused until you act
          </h2>
          <ul className="divide-y divide-line border-t border-line">
            {waiting.slice(0, 6).map(({ j, a }) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/jobs/${j.id}`} className="block truncate text-[13px] font-medium text-fg hover:underline">
                    {j.title}
                  </Link>
                  <p className="truncate text-xs text-fg-3">{a.detail}</p>
                </div>
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <Link href={`/jobs/${j.id}`} data-testid="jobs-needs-you-open">
                    {a.label} <ArrowRight className="size-3.5" strokeWidth={1.75} />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <nav aria-label="Job pipeline" className="mb-5 overflow-x-auto">
        <ol className="flex min-w-max gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line">
          {PIPELINE.map((s, i) => {
            const m = JOB_META[s];
            const on = state === s;
            return (
              <li key={s} className="flex-1">
                <Link
                  href={on ? "/jobs" : `/jobs?state=${s}`}
                  scroll={false}
                  aria-current={on ? "true" : undefined}
                  className={cn("flex min-w-[112px] flex-col gap-0.5 bg-bg px-3 py-2 transition-colors hover:bg-surface-1", on && "bg-surface-2 hover:bg-surface-2")}
                >
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3">
                    <span className="font-mono text-[10px] text-fg-4">{String(i + 1).padStart(2, "0")}</span>
                    {m.label}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className={cn("text-[18px] font-semibold tracking-[-0.01em]", counts[s] ? "text-fg" : "text-fg-4")}>{counts[s]}</span>
                    {counts[s] && m.live ? <StatusDot tone={m.tone} live /> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
      {shown.length === 0 ? (
        <EmptyState
          icon={<SquareKanban />}
          title={state ? `No jobs in ${JOB_META[state].label.toLowerCase()}` : "No jobs yet"}
          description="Jobs are created when you mark an application won. The Production Planner then builds the workflow and agents start producing."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/applications">Open applications</Link>
            </Button>
          }
        />
      ) : (
        <DataTable label="Jobs" minWidth={1080} className="rounded-md ring-1 ring-inset ring-line">
          <THead>
            <tr>
              <TH>Job</TH>
              <TH>State</TH>
              <TH>Progress</TH>
              <TH align="right">Price</TH>
              <TH>Spend vs limit</TH>
              <TH align="right">Est. cost</TH>
              <TH align="right">Actual</TH>
              <TH align="right">Repairs</TH>
              <TH align="right">Due</TH>
            </tr>
          </THead>
          <TBody>
            {shown.map((j) => {
              const m = JOB_META[j.status];
              const spendPct = j.spendLimitUsd > 0 ? j.actualCostUsd / j.spendLimitUsd : 0;
              const variance = j.estimatedCostUsd > 0 && j.actualCostUsd > 0 ? j.actualCostUsd / j.estimatedCostUsd - 1 : null;
              const action = ["delivered", "closed", "cancelled"].includes(j.status) ? null : ownerAction(j);
              return (
                <ClickableRow key={j.id} href={`/jobs/${j.id}`} data-testid="job-row" data-job-id={j.id} data-status={j.status} className="[&>td]:h-11">
                  <TD className="max-w-[340px]">
                    <Link href={`/jobs/${j.id}`} className="block truncate font-medium text-fg hover:underline">
                      {j.title}
                    </Link>
                    <span className="block truncate text-[11px] text-fg-3">
                      {j.clientName ?? "Client"} · {j.sourceKey ? (SOURCE_SHORT[j.sourceKey] ?? j.sourceKey) : "direct"} · {j.serviceFamily.replace(/-/g, " ")}
                    </span>
                  </TD>
                  <TD>
                    <span className={cn("inline-flex items-center gap-1.5 text-xs", m.tone === "accent" ? "text-accent-hi" : "text-fg-2")}>
                      <StatusDot tone={m.tone} live={m.live && !action} />
                      {m.label}
                    </span>
                    {action ? (
                      <span className="block text-[10.5px] font-medium text-accent-hi" data-testid="job-row-needs-you">
                        Needs you · {action.label.toLowerCase()}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="w-40">
                    <div className="flex items-center gap-2">
                      <BarMeter value={j.total ? j.done / j.total : 0} tone={j.status === "repairing" ? "warn" : j.done === j.total && j.total ? "profit" : "info"} className="w-20" label={`${j.done} of ${j.total} steps`} />
                      <span className="font-mono text-[11px] tabular text-fg-3">
                        {j.done}/{j.total}
                      </span>
                    </div>
                  </TD>
                  <TD num>{formatUsd(j.priceUsd)}</TD>
                  <TD className="w-44">
                    <div className="flex items-center gap-2">
                      <BarMeter value={spendPct} max={1} tone={spendPct > 0.9 ? "risk" : spendPct > 0.7 ? "warn" : "neutral"} className="w-20" label={`Spend ${Math.round(spendPct * 100)}% of limit`} />
                      <span className="font-mono text-[11px] tabular text-fg-3">{formatUsd(j.spendLimitUsd)}</span>
                    </div>
                  </TD>
                  <TD num className="text-fg-2">{formatUsd(j.estimatedCostUsd, { cents: true })}</TD>
                  <TD num>
                    {formatUsd(j.actualCostUsd, { cents: true })}
                    {variance !== null && ["awaiting_final_approval", "delivered", "closed"].includes(j.status) ? (
                      <span className={cn("ml-1.5 text-[10.5px]", Math.abs(variance) <= 0.2 ? "text-fg-3" : "text-warn")}>
                        {variance > 0 ? "+" : "−"}
                        {Math.abs(Math.round(variance * 100))}%
                      </span>
                    ) : null}
                  </TD>
                  <TD num className={j.repairCount ? "text-warn" : "text-fg-3"}>{j.repairCount || "—"}</TD>
                  <TD align="right" className="text-xs text-fg-3">
                    {j.dueAt ? <RelTime date={j.dueAt} /> : "—"}
                  </TD>
                </ClickableRow>
              );
            })}
          </TBody>
        </DataTable>
      )}
    </div>
  );
}
