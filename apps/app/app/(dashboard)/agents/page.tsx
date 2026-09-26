import type { Metadata } from "next";
import Link from "next/link";
import { Bot } from "lucide-react";
import { AGENTS, RUN_STATES, type RunState } from "@gigpilot/contracts";
import { DataTable, EmptyState, SegmentedControl, StatusDot, TBody, TD, TH, THead, TR, Tooltip, cn, formatUsd } from "@gigpilot/ui";
import { AgentFilter } from "@/components/agents/agent-filter";
import { Runtime } from "@/components/live/runtime";
import { PageHeader } from "@/components/page-header";
import { RelTime } from "@/components/rel-time";
import { RUN_META, agentName } from "@/lib/labels";
import { getAgentRuns } from "@/lib/queries/agents";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const sp = await searchParams;
  const agent = typeof sp.agent === "string" && sp.agent in AGENTS ? sp.agent : undefined;
  const state = typeof sp.state === "string" && (RUN_STATES as readonly string[]).includes(sp.state) ? (sp.state as RunState) : undefined;
  const jobId = typeof sp.job === "string" ? sp.job : undefined;
  const { runs, summary, stateCounts } = await getAgentRuns(ctx.tenantId, { agent, state, jobId });
  const byAgent = new Map(summary.map((s) => [s.agent, s]));
  const runningTotal = summary.reduce((s, a) => s + a.running, 0);
  const runs24 = summary.reduce((s, a) => s + a.runs24h, 0);
  const cost24 = summary.reduce((s, a) => s + a.cost24h, 0);
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { agent, state, job: jobId, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/agents?${s}` : "/agents";
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Agents"
        title="The crew, live"
        description={`${runningTotal} running now · ${runs24} runs and ${formatUsd(cost24, { cents: true })} in the last 24h · retries create new attempts, never overwrite history`}
      />

      <section aria-label="Agent roster" className="mb-7">
        <ul className="flex overflow-x-auto rounded-md border-l border-t border-line sm:grid sm:grid-cols-3 sm:overflow-hidden lg:grid-cols-4 2xl:grid-cols-6">
          {(Object.entries(AGENTS) as [string, { name: string; role: string }][]).map(([key, a]) => {
            const s = byAgent.get(key);
            const on = agent === key;
            return (
              <li key={key} className="w-[220px] shrink-0 border-b border-r border-line sm:w-auto">
                <Tooltip content={a.role}>
                  <Link
                    href={on ? qs({ agent: undefined }) : qs({ agent: key })}
                    scroll={false}
                    aria-current={on ? "true" : undefined}
                    className={cn("flex h-full flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-surface-1", on && "bg-surface-2 hover:bg-surface-2")}
                  >
                    <span className="flex items-center gap-2">
                      <StatusDot tone={s?.running ? "info" : s?.failed24h ? "warn" : s?.runs24h ? "profit" : "neutral"} live={Boolean(s?.running)} />
                      <span className="truncate text-[13px] font-medium text-fg">{a.name}</span>
                    </span>
                    <span className="truncate pl-3.5 text-[11px] text-fg-3">{a.role}</span>
                    <span className="flex items-center gap-3 pl-3.5 font-mono text-[10.5px] tabular text-fg-3">
                      <span className={s?.running ? "text-info" : undefined}>{s?.running ?? 0} run</span>
                      <span>{s?.runs24h ?? 0}/24h</span>
                      {s?.failed24h ? <span className="text-warn">{s.failed24h} fail</span> : null}
                      <span className="ml-auto">{formatUsd(s?.cost24h ?? 0, { cents: true })}</span>
                    </span>
                  </Link>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Run state"
          value={state ?? "all"}
          items={[
            { value: "all", label: "All", href: qs({ state: undefined }) },
            ...(["running", "queued", "failed", "succeeded"] as RunState[]).map((s) => ({ value: s, label: RUN_META[s].label, count: stateCounts[s] ?? 0, href: qs({ state: s }) })),
          ]}
        />
        <AgentFilter value={agent ?? ""} />
        {jobId ? (
          <Link href={qs({ job: undefined })} className="rounded-xs bg-surface-2 px-2 py-1 text-xs text-fg-2 ring-1 ring-inset ring-line-strong hover:text-fg">
            Job filter ✕
          </Link>
        ) : null}
        <p className="ml-auto text-xs text-fg-3">{runs.length} runs shown · newest first, running pinned</p>
      </div>

      {runs.length === 0 ? (
        <EmptyState icon={<Bot />} title="No runs match" description="Agent runs appear as soon as sourcing, analysis or production work starts. Clear the filters to see everything." />
      ) : (
        <DataTable label="Agent runs" minWidth={1180} className="max-h-[min(72vh,760px)] overflow-y-auto rounded-md ring-1 ring-inset ring-line">
          <THead sticky>
            <tr>
              <TH>Agent</TH>
              <TH>Task</TH>
              <TH>State</TH>
              <TH>Model</TH>
              <TH align="right">Started</TH>
              <TH align="right">Runtime</TH>
              <TH align="right">Cost</TH>
              <TH>Depends on</TH>
              <TH>Latest event</TH>
              <TH align="right">Attempt</TH>
            </tr>
          </THead>
          <TBody>
            {runs.map((r) => {
              const m = RUN_META[r.status];
              const link = r.jobId ? `/jobs/${r.jobId}` : r.subjectType === "opportunity" && r.subjectId ? `/radar/${r.subjectId}` : null;
              return (
                <TR key={r.id} data-testid="agent-run-row" data-agent={r.agent} data-status={r.status}>
                  <TD className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-2 font-medium text-fg">
                      <StatusDot tone={m.tone} live={m.live} />
                      {agentName(r.agent)}
                    </span>
                  </TD>
                  <TD className="max-w-[280px]">
                    {link ? (
                      <Link href={link} className="block truncate text-fg-2 hover:text-fg hover:underline" title={r.task}>
                        {r.task}
                      </Link>
                    ) : (
                      <span className="block truncate text-fg-2" title={r.task}>
                        {r.task}
                      </span>
                    )}
                    {r.jobTitle ? <span className="block truncate text-[11px] text-fg-3">{r.jobTitle}</span> : null}
                  </TD>
                  <TD>
                    <span className={cn("text-xs", r.status === "failed" ? "text-risk" : r.status === "running" ? "text-info" : "text-fg-2")}>{m.label}</span>
                  </TD>
                  <TD className="font-mono text-[11px] text-fg-3">{r.provider ? `${r.provider}/${r.model ?? "—"}` : "—"}</TD>
                  <TD align="right" className="text-xs text-fg-3">
                    <RelTime date={r.startedAt ?? r.createdAt} />
                  </TD>
                  <TD num>
                    <Runtime start={r.startedAt?.toISOString() ?? null} end={r.status === "running" ? null : (r.finishedAt?.toISOString() ?? r.startedAt?.toISOString() ?? null)} className={r.status === "running" ? "text-info" : undefined} />
                  </TD>
                  <TD num>{formatUsd(r.costUsd, { cents: true })}</TD>
                  <TD className="max-w-[140px] truncate font-mono text-[11px] text-fg-3" title={r.dependencies.join(", ")}>
                    {r.dependencies.length ? r.dependencies.join(", ") : "—"}
                  </TD>
                  <TD className="max-w-[300px]">
                    <span className={cn("block truncate text-xs", r.error ? "text-risk" : "text-fg-3")} title={r.error ?? r.eventMessage ?? r.summary ?? undefined}>
                      {r.error ?? r.eventMessage ?? r.summary ?? "—"}
                    </span>
                  </TD>
                  <TD num className={r.attempt > 1 ? "text-warn" : "text-fg-3"}>
                    #{r.attempt}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </DataTable>
      )}
    </div>
  );
}
