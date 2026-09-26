import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Bell, CircleAlert, CircleCheck, Info } from "lucide-react";
import { BarMeter, MetricStrip, Metric, RecChip, SectionHeader, Sparkline, StatusDot, cn, formatPct, formatUsd } from "@gigpilot/ui";
import { SampleBadge } from "@/components/sample/sample-badge";
import { SampleNotice } from "@/components/sample/sample-notice";
import { OperatingGoals } from "@/components/command-center/goals";
import { NeedsYou } from "@/components/command-center/needs-you";
import { RefreshSourcesButton } from "@/components/actions/refresh-sources-button";
import { ActivityStream } from "@/components/live/activity-stream";
import { PageHeader } from "@/components/page-header";
import { RelTime } from "@/components/rel-time";
import { StateText } from "@/components/state-badge";
import { JOB_META, agentName } from "@/lib/labels";
import { getCommandCenter, type CommandCenterData } from "@/lib/queries/command-center";
import { listRecentEvents } from "@/lib/queries/events";
import { getTenantMeta } from "@/lib/queries/tenant";
import { requireSession } from "@/lib/session";
import type { JobState } from "@gigpilot/contracts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Command Center" };

function greeting(): string {
  const h = new Date().getUTCHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "$2.72 simulated · $0 paid" — one spend phrasing everywhere on the page. */
function spendPhrase(sim: number, paid: number): string {
  return `${formatUsd(sim, { cents: true })} simulated · ${formatUsd(paid, { cents: paid > 0 })} paid`;
}

export default async function CommandCenterPage() {
  const ctx = await requireSession();
  const [data, events, meta] = await Promise.all([getCommandCenter(ctx.tenantId), listRecentEvents(ctx.tenantId, { limit: 40 }), getTenantMeta(ctx.tenantId)]);
  const c = data.counts;
  const first = ctx.user.name.split(" ")[0] || "there";
  const spendToday = data.spend.todayPaid + data.spend.todaySim;
  const decisions = data.needsYou.filter((n) => n.kind !== "pursue").length;
  const pipelineMargin = data.pipeline.valueUsd > 0 ? data.pipeline.profitUsd / data.pipeline.valueUsd : null;
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="page">
      <PageHeader
        title="Command Center"
        tagline={`${greeting()}, ${first} · ${today}`}
        description={
          <>
            {c.opps24h} opportunities in the last 24h · {decisions} decision{decisions === 1 ? "" : "s"} waiting · {c.activeJobs} job{c.activeJobs === 1 ? "" : "s"} in production · spend today{" "}
            <span className="font-mono text-xs">{spendPhrase(data.spend.todaySim, data.spend.todayPaid)}</span>
          </>
        }
        actions={<RefreshSourcesButton />}
      />

      <div className="flex flex-col gap-6">
        {meta.hasSample ? <SampleNotice tenantId={ctx.tenantId} /> : null}
        <NeedsYou items={data.needsYou} />

        <MetricStrip>
          <Metric
            label="Opportunities · 24h"
            value={c.opps24h}
            sub={`${c.viable24h} viable · ${c.pursue24h} pursue`}
            trend={<Sparkline values={data.daily.map((d) => d.discovered)} label={`Discovered per day, last 14 days: ${data.daily.map((d) => d.discovered).join(", ")}`} width={64} height={22} />}
          />
          <Metric label="Shortlisted" value={c.shortlisted} sub={<Link href="/radar?status=shortlisted" className="hover:text-fg">view on Radar</Link>} />
          <Metric label="Proposals awaiting" value={c.proposalsAwaiting} sub="commercial approvals" />
          <Metric label="Active jobs" value={c.activeJobs} sub={`${data.production.filter((p) => p.running > 0).length} executing now`} />
          <Metric label="Final review" value={c.awaitingFinal} sub="deliveries to approve" />
          <Metric label="Open pipeline" value={formatUsd(data.pipeline.valueUsd)} sub={`${data.pipeline.count} opportunities`} />
          <Metric label="Expected profit" value={formatUsd(data.pipeline.profitUsd)} sub={pipelineMargin === null ? "—" : `${formatPct(pipelineMargin)} margin after owner time`} />
          <Metric label="Spend · today" value={formatUsd(spendToday, { cents: true })} sub={<span className="font-mono text-[11px]">{spendPhrase(data.spend.todaySim, data.spend.todayPaid)}</span>} />
        </MetricStrip>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-7">
            <OperatingGoals data={data} />
            <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
              <Funnel data={data} />
              <SpendPanel data={data} />
            </div>
            <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
              <AgentSummary data={data} />
              <ProductionList data={data} />
            </div>
          </div>

          <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-5 xl:self-start" aria-label="Live">
            <Alerts data={data} />
            <section aria-labelledby="stream-title">
              <SectionHeader
                id="stream-title"
                title="Live activity"
                meta="agent event stream"
                actions={
                  <Link href="/agents" className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                    Agents <ArrowUpRight className="size-3" />
                  </Link>
                }
              />
              <div className="-mx-1.5 max-h-[560px] overflow-y-auto overscroll-contain px-1.5 pr-1">
                <ActivityStream initial={events} limit={40} sampleBefore={meta.createdAt.toISOString()} />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Funnel({ data }: { data: CommandCenterData }) {
  const top = Math.max(1, data.funnel[0]?.value ?? 1);
  return (
    <section aria-labelledby="funnel-title">
      <SectionHeader id="funnel-title" title="Pipeline · 30-day cohort" meta="discovered in the last 30 days" />
      <ol className="flex flex-col gap-2">
        {data.funnel.map((f, i) => {
          const prev = i > 0 ? data.funnel[i - 1]!.value : null;
          const conv = prev ? f.value / prev : null;
          return (
            <li key={f.key} className="grid grid-cols-[120px_minmax(0,1fr)_40px_44px] items-center gap-3">
              <span className="text-xs text-fg-2">{f.label}</span>
              <span className="relative h-[14px]">
                <span className="absolute inset-y-0 left-0 rounded-r-[3px] bg-series-1/85" style={{ width: `${Math.max(f.value > 0 ? 1.5 : 0, (f.value / top) * 100)}%` }} />
              </span>
              <span className="text-right font-mono text-xs tabular text-fg">{f.value}</span>
              <span className="text-right font-mono text-[11px] tabular text-fg-3">{conv === null ? "" : formatPct(conv)}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-fg-3">Right column: conversion from the previous stage. Sample history excluded.</p>
    </section>
  );
}

function SpendPanel({ data }: { data: CommandCenterData }) {
  const days = data.daily;
  const max = Math.max(0.01, ...days.map((d) => d.spend));
  const s = data.spend;
  return (
    <section aria-labelledby="spend-title">
      <SectionHeader
        id="spend-title"
        title="Spend · 14 days"
        meta={spendPhrase(s.d14Sim, s.d14Paid)}
        actions={
          <Link href="/costs" className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
            Ledger <ArrowUpRight className="size-3" />
          </Link>
        }
      />
      <div className="flex h-[88px] items-end gap-[3px]" role="img" aria-label={`Daily production spend, last 14 days: ${days.map((d) => `${d.day} ${formatUsd(d.spend, { cents: true })}`).join("; ")}`}>
        {days.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${d.day}: ${formatUsd(d.spend, { cents: true })}`}>
            <div className="w-full rounded-t-[3px] bg-series-1/85 transition-opacity group-hover:opacity-100" style={{ height: `${Math.max(d.spend > 0 ? 3 : 1, (d.spend / max) * 100)}%`, opacity: d.spend > 0 ? 0.9 : 0.25 }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-fg-3">
        <span>{days[0] ? new Date(`${days[0].day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</span>
        <span>today</span>
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs">
        <dt className="text-fg-3">Today</dt>
        <dd className="whitespace-nowrap text-right font-mono tabular text-fg-2">{spendPhrase(s.todaySim, s.todayPaid)}</dd>
        <dt className="text-fg-3">14 days</dt>
        <dd className="whitespace-nowrap text-right font-mono tabular text-fg-2">{spendPhrase(s.d14Sim, s.d14Paid)}</dd>
        <dt className="text-fg-3">Daily paid limit</dt>
        <dd className="text-right font-mono tabular text-fg-2">
          {data.settings.limits.dailyPaidSpendLimitUsd > 0 ? formatUsd(data.settings.limits.dailyPaidSpendLimitUsd, { cents: true }) : <Link href="/settings#limits" className="text-warn hover:underline">$0 · paid off</Link>}
        </dd>
      </dl>
    </section>
  );
}

function AgentSummary({ data }: { data: CommandCenterData }) {
  const rows = data.agents.slice(0, 7);
  const runs = data.agents.reduce((s, a) => s + a.runs, 0);
  return (
    <section aria-labelledby="agents-title">
      <SectionHeader
        id="agents-title"
        title="Agents · 24h"
        meta={`${runs} run${runs === 1 ? "" : "s"}`}
        actions={
          <Link href="/agents" className="flex items-center gap-1 rounded-sm text-xs text-fg-3 hover:text-fg">
            All runs <ArrowUpRight className="size-3" />
          </Link>
        }
      />
      {rows.length === 0 ? (
        <p className="py-4 text-xs text-fg-3">No agent runs in the last 24 hours.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="font-mono text-[11px] uppercase tracking-[0.05em] text-fg-3">
              <th scope="col" className="pb-1.5 text-left font-medium">Agent</th>
              <th scope="col" className="w-10 pb-1.5 text-right font-medium">Runs</th>
              <th scope="col" className="w-14 pb-1.5 text-right font-medium">Failed</th>
              <th scope="col" className="w-16 pb-1.5 text-right font-medium">Cost</th>
              <th scope="col" className="w-12 pb-1.5 text-right font-medium">Last</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {rows.map((a) => (
              <tr key={a.agent} className="h-8">
                <td className="max-w-0 pr-2">
                  <span className="flex items-center gap-2 truncate text-[13px] text-fg">
                    <StatusDot tone={a.running > 0 ? "info" : a.failed > 0 ? "warn" : "neutral"} live={a.running > 0} />
                    <span className="truncate">{agentName(a.agent)}</span>
                    {a.running > 0 ? <span className="sr-only">{a.running} running</span> : null}
                  </span>
                </td>
                <td className="text-right font-mono tabular text-fg-2">{a.runs}</td>
                <td className={cn("text-right font-mono tabular", a.failed ? "text-warn" : "text-fg-3")}>{a.failed || "—"}</td>
                <td className="text-right font-mono tabular text-fg-2">{formatUsd(a.costUsd, { cents: true })}</td>
                <td className="text-right">
                  <RelTime date={a.lastAt} compact className="font-mono text-[11px] text-fg-3" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ProductionList({ data }: { data: CommandCenterData }) {
  return (
    <section aria-labelledby="prod-title">
      <SectionHeader
        id="prod-title"
        title="In production"
        meta={`${data.production.length} active`}
        actions={
          <Link href="/production" className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
            Production <ArrowUpRight className="size-3" />
          </Link>
        }
      />
      {data.production.length === 0 ? (
        <p className="py-4 text-xs text-fg-3">No active jobs. Won applications become jobs automatically.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.production.map((j) => {
            const meta = JOB_META[j.status as JobState] ?? JOB_META.intake;
            const pct = j.total ? j.done / j.total : 0;
            return (
              <li key={j.id} className="py-2.5">
                <div className="flex items-center gap-3">
                  <Link href={`/jobs/${j.id}`} className="min-w-0 flex-1 truncate text-[13px] text-fg hover:underline">
                    {j.title}
                  </Link>
                  <StateText meta={meta} />
                </div>
                <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <BarMeter value={pct} max={1} tone={j.status === "repairing" ? "warn" : j.status === "awaiting_final_approval" ? "profit" : "info"} label={`${j.done} of ${j.total} steps done`} />
                  <span className="font-mono text-[11px] tabular text-fg-3">
                    {j.done}/{j.total} steps · {formatUsd(j.actualCostUsd, { cents: true })} of {formatUsd(j.spendLimitUsd)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** "$2,317 expected profit at 68% margin" → "$2,317 · 68%" chip for dense alert rows. */
function alertChip(body: string): string | null {
  const m = /(−?\$[\d,]+(?:\.\d+)?) expected profit at (\d+)% margin/.exec(body);
  return m ? `${m[1]} · ${m[2]}%` : null;
}

function Alerts({ data }: { data: CommandCenterData }) {
  const unread = data.notifications.filter((n) => !n.read && !n.sample);
  const icon = (k: string) =>
    k === "alert" ? <CircleAlert className="size-3.5 text-warn" strokeWidth={1.75} /> : k === "success" ? <CircleCheck className="size-3.5 text-profit" strokeWidth={1.75} /> : k === "approval" ? <Bell className="size-3.5 text-fg-2" strokeWidth={1.75} /> : <Info className="size-3.5 text-info" strokeWidth={1.75} />;
  return (
    <section aria-labelledby="alerts-title">
      <SectionHeader id="alerts-title" title="Alerts" meta={unread.length ? `${unread.length} unread` : "all caught up"} />
      {data.notifications.length === 0 ? (
        <p className="py-2 text-xs text-fg-3">No alerts. Budget blocks, repair limits and approvals show up here.</p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {data.notifications.slice(0, 5).map((n) => {
            const chip = alertChip(n.body);
            const pursue = /^Pursue\s+/.test(n.title);
            const title = n.title.replace(/^Pursue\s+/, "").replace(/^[“"](.*)[”"]$/, "$1");
            const shown = n.sample ? n.title.replace(/^Sample data:\s*/i, "") : n.title;
            const inner = (
              <>
                <span className="mt-[3px] shrink-0">{icon(n.kind)}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn("line-clamp-2 text-[13px] leading-5", n.read ? "text-fg-3" : "text-fg")}>{pursue ? title : shown}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {pursue ? <RecChip rec="pursue" size="sm" /> : null}
                    {chip ? <span className="font-mono text-[11px] tabular text-fg-2">{chip}</span> : n.body ? <span className="line-clamp-1 text-xs text-fg-3">{n.body}</span> : null}
                    {n.sample ? <SampleBadge className="h-4" /> : null}
                  </span>
                </span>
                <RelTime date={n.createdAt} compact className="shrink-0 font-mono text-[11px] text-fg-3" />
              </>
            );
            return (
              <li key={n.id}>
                {n.link ? (
                  <Link href={n.link} className="focus-inset flex gap-2.5 rounded-sm px-1.5 py-2 hover:bg-surface-1">
                    {inner}
                  </Link>
                ) : (
                  <div className="flex gap-2.5 px-1.5 py-2">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
