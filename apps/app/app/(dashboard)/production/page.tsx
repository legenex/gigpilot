import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Workflow } from "lucide-react";
import type { JobState, StepState } from "@gigpilot/contracts";
import { BarMeter, Button, EmptyState, SectionHeader, StatusDot, cn, formatUsd } from "@gigpilot/ui";
import { Dag, type DagRepair } from "@/components/dag/dag";
import { Runtime } from "@/components/live/runtime";
import { PageHeader } from "@/components/page-header";
import { RetryStepButton } from "@/components/production/retry-step";
import { RelTime } from "@/components/rel-time";
import { StateBadge } from "@/components/state-badge";
import { JOB_META, RUN_META, STEP_META, agentName } from "@/lib/labels";
import { getProduction } from "@/lib/queries/production";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Production" };

export default async function ProductionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const sp = await searchParams;
  const jobId = typeof sp.job === "string" ? sp.job : undefined;
  const stepKey = typeof sp.step === "string" ? sp.step : undefined;
  const { jobs, selected } = await getProduction(ctx.tenantId, jobId, stepKey);
  const running = jobs.reduce((s, j) => s + j.running, 0);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Production"
        title="Workflows, step by step"
        description={`${jobs.filter((j) => !["delivered", "closed", "cancelled"].includes(j.status)).length} jobs in flight · ${running} step${running === 1 ? "" : "s"} running now · every attempt, route and repair is recorded`}
      />
      {jobs.length === 0 || !selected ? (
        <EmptyState
          icon={<Workflow />}
          title="Nothing in production"
          description="When you mark an application won, the Production Planner builds a workflow DAG here and agents start executing it."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/applications">Open applications</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Jobs" className="min-w-0">
            <p className="eyebrow hairline-b mb-2 pb-2">Jobs</p>
            <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible">
              {jobs.map((j) => {
                const m = JOB_META[j.status as JobState] ?? JOB_META.intake;
                const on = j.id === selected.job.id;
                return (
                  <li key={j.id} className="w-60 shrink-0 lg:w-auto">
                    <Link
                      href={`/production?job=${j.id}`}
                      scroll={false}
                      aria-current={on ? "page" : undefined}
                      className={cn("block rounded-sm px-2.5 py-2 ring-1 ring-inset ring-transparent transition-colors hover:bg-surface-1", on && "bg-surface-2 ring-line-strong hover:bg-surface-2")}
                    >
                      <span className="flex items-center gap-2">
                        <StatusDot tone={m.tone} live={j.running > 0} />
                        <span className="truncate text-[13px] text-fg">{j.title}</span>
                      </span>
                      <span className="mt-1.5 flex items-center gap-2 pl-3.5">
                        <BarMeter value={j.total ? j.done / j.total : 0} tone={j.failed ? "warn" : j.total && j.done === j.total ? "profit" : "info"} height={3} className="flex-1" label={`${j.done}/${j.total} steps`} />
                        <span className="font-mono text-[10.5px] tabular text-fg-3">
                          {j.done}/{j.total}
                        </span>
                      </span>
                      <span className="mt-1 block pl-3.5 text-[11px] text-fg-3">
                        {m.label}
                        {j.running ? ` · ${j.running} running` : ""}
                        {j.failed ? ` · ${j.failed} failed` : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-6">
            <JobCanvas data={selected} />
          </div>
        </div>
      )}
    </div>
  );
}

type Selected = NonNullable<Awaited<ReturnType<typeof getProduction>>["selected"]>;

function JobCanvas({ data }: { data: Selected }) {
  const { job, steps, repairs, step, stepRuns, stepGenerations, stepAssets, workflow, runCounts } = data;
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const qa = steps.find((s) => s.kind === "qa");
  const loops: DagRepair[] = qa
    ? repairs.filter((r) => r.stepId && stepById.has(r.stepId)).map((r, i, arr) => ({ fromKey: qa.key, toKey: stepById.get(r.stepId!)!.key, label: `${r.strategy} ${arr.length - i}`, status: r.status }))
    : [];
  const spendPct = job.spendLimitUsd > 0 ? job.actualCostUsd / job.spendLimitUsd : 0;
  const keys = new Set(steps.map((s) => s.key));
  return (
    <>
      <section aria-labelledby="canvas-title">
        <div className="hairline-b mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
          <div className="min-w-0">
            <h2 id="canvas-title" className="truncate text-[15px] font-semibold text-fg">
              {job.title}
            </h2>
            <p className="font-mono text-[11px] text-fg-3">
              workflow v{workflow?.version ?? "—"} · {steps.length} steps · {repairs.length} repair{repairs.length === 1 ? "" : "s"}
            </p>
          </div>
          <StateBadge meta={JOB_META[job.status as JobState] ?? JOB_META.intake} />
          <div className="ml-auto flex items-center gap-3">
            <div className="w-40">
              <div className="mb-1 flex justify-between font-mono text-[10.5px] text-fg-3">
                <span>spend</span>
                <span className="tabular">
                  {formatUsd(job.actualCostUsd, { cents: true })} / {formatUsd(job.spendLimitUsd)}
                </span>
              </div>
              <BarMeter value={spendPct} tone={spendPct > 0.9 ? "risk" : spendPct > 0.7 ? "warn" : "neutral"} label="Job spend against limit" />
            </div>
            <Link href={`/jobs/${job.id}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
              Job <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>
        <div className="rounded-md bg-[radial-gradient(var(--gp-line)_1px,transparent_1px)] p-5 [background-size:16px_16px] ring-1 ring-inset ring-line">
          {steps.length === 0 ? (
            <p className="flex items-center gap-2 py-6 text-[13px] text-fg-2">
              <StatusDot tone="info" live={["intake", "planning"].includes(job.status)} />
              {["intake", "planning"].includes(job.status) ? "The Production Planner is turning the accepted scope into a workflow DAG — steps appear here as soon as it’s planned." : "No workflow steps recorded for this job."}
            </p>
          ) : (
          <Dag
            nodes={steps.map((s) => ({
              key: s.key,
              name: s.name,
              agent: s.agent,
              kind: s.kind,
              dependsOn: s.dependsOn.filter((k) => keys.has(k)),
              status: s.status,
              provider: s.provider,
              model: s.model,
              attempts: s.attempts,
              maxAttempts: s.maxAttempts,
              costUsd: s.actualCostUsd,
              estimatedCostUsd: s.estimatedCostUsd,
            }))}
            repairs={loops}
            selectedKey={step?.key ?? null}
            hrefs={Object.fromEntries(steps.map((s) => [s.key, `/production?job=${job.id}&step=${s.key}`]))}
            label={`Workflow for ${job.title}`}
          />
          )}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-3" aria-label="Legend">
          {(["running", "succeeded", "failed", "blocked", "pending"] as StepState[]).map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <StatusDot tone={STEP_META[s].tone} />
              {STEP_META[s].label}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="h-px w-4 border-t border-dashed border-warn" aria-hidden /> repair loop
          </li>
          <li className="flex items-center gap-1.5">
            <span className="font-mono text-warn">×2/3</span> attempts / limit
          </li>
        </ul>
      </section>

      {step ? (
        <section aria-labelledby="inspector-title" className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <SectionHeader
              id="inspector-title"
              eyebrow="Step"
              title={step.name}
              meta={`${step.kind} · ${agentName(step.agent)}${step.capability ? ` · ${step.capability}` : ""}`}
              actions={
                step.status === "failed" || step.status === "blocked" ? (
                  <RetryStepButton stepId={step.id} disabled={step.attempts >= step.maxAttempts} reason={step.attempts >= step.maxAttempts ? "Attempt limit reached" : undefined} />
                ) : null
              }
            />
            {step.error ? <p className="mb-3 rounded-sm bg-risk-wash px-3 py-2 text-[13px] text-risk">{step.error}</p> : null}
            <p className="mb-1.5 text-xs text-fg-3">Attempt history</p>
            {stepRuns.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead>
                    <tr className="text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">
                      <th className="w-8 pb-1.5 font-medium">#</th>
                      <th className="pb-1.5 font-medium">State</th>
                      <th className="pb-1.5 font-medium">Route</th>
                      <th className="pb-1.5 text-right font-medium">Runtime</th>
                      <th className="pb-1.5 pl-3 text-right font-medium">Tokens</th>
                      <th className="pb-1.5 text-right font-medium">Cost</th>
                      <th className="pb-1.5 pl-4 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {stepRuns.map((r) => {
                      const m = RUN_META[r.status];
                      return (
                        <tr key={r.id} className="h-9 align-middle">
                          <td className="font-mono text-xs text-fg-2">{r.attempt}</td>
                          <td>
                            <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
                              <StatusDot tone={m.tone} live={m.live} />
                              {m.label}
                            </span>
                          </td>
                          <td className="font-mono text-xs text-fg-3">{r.provider ? `${r.provider}/${r.model}` : "—"}</td>
                          <td className="text-right font-mono text-xs tabular text-fg-2">
                            <Runtime start={r.startedAt?.toISOString() ?? null} end={r.finishedAt?.toISOString() ?? null} />
                          </td>
                          <td className="pl-3 text-right font-mono text-xs tabular text-fg-3">{r.inputTokens || r.outputTokens ? `${Math.round(r.inputTokens / 100) / 10}k/${Math.round(r.outputTokens / 100) / 10}k` : "—"}</td>
                          <td className="text-right font-mono text-xs tabular text-fg">{formatUsd(r.costUsd, { cents: true })}</td>
                          <td className={cn("max-w-[260px] truncate pl-4 text-xs", r.error ? "text-risk" : "text-fg-3")} title={r.error ?? r.summary ?? undefined}>
                            {r.error ?? r.summary ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-fg-3">{step.status === "pending" ? "Waiting on upstream steps." : "No runs recorded for this step."}</p>
            )}

            {stepGenerations.length ? (
              <>
                <p className="mb-1.5 mt-5 text-xs text-fg-3">Generations</p>
                <ul className="divide-y divide-line">
                  {stepGenerations.map((g) => (
                    <li key={g.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 py-2 text-xs">
                      <span className="min-w-0">
                        <span className="font-mono text-fg-2">
                          {g.provider}/{g.model}
                        </span>
                        {g.routeRationale ? <span className="mt-0.5 block truncate text-fg-3">{g.routeRationale}</span> : null}
                      </span>
                      <span className={cn("font-mono", g.qaPassed === false ? "text-risk" : g.qaPassed ? "text-profit" : "text-fg-3")}>{g.qaPassed === null ? g.status : g.qaPassed ? "QA pass" : "QA fail"}</span>
                      <span className="font-mono tabular text-fg">{formatUsd(g.actualCostUsd ?? g.estimatedCostUsd, { cents: true })}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {stepAssets.length ? (
              <>
                <p className="mb-2 mt-5 text-xs text-fg-3">Outputs</p>
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {stepAssets.map((a) =>
                    a.kind === "image" ? (
                      <li key={a.id}>
                        <a href={`/api/assets/${a.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-sm ring-1 ring-inset ring-line hover:ring-line-bright">
                          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated asset route */}
                          <img src={`/api/assets/${a.id}`} alt={a.filename} loading="lazy" className="aspect-square w-full object-cover" />
                        </a>
                      </li>
                    ) : (
                      <li key={a.id} className="truncate font-mono text-[11px] text-fg-3">
                        <a href={`/api/assets/${a.id}?download=1`} className="hover:text-fg">
                          {a.filename}
                        </a>
                      </li>
                    ),
                  )}
                </ul>
              </>
            ) : null}
          </div>

          <dl className="flex flex-col gap-3 text-xs xl:border-l xl:border-line xl:pl-6">
            {[
              ["State", <span key="s" className="inline-flex items-center gap-1.5"><StatusDot tone={STEP_META[step.status].tone} live={STEP_META[step.status].live} />{STEP_META[step.status].label}</span>],
              ["Attempts", <span key="a" className={cn("font-mono tabular", step.attempts >= step.maxAttempts ? "text-risk" : "text-fg")}>{step.attempts} / {step.maxAttempts}</span>],
              ["Route", <span key="r" className="font-mono">{step.provider ? `${step.provider}/${step.model}` : "decided at run time"}</span>],
              ["Estimated", <span key="e" className="font-mono tabular">{formatUsd(step.estimatedCostUsd, { cents: true })}</span>],
              ["Actual", <span key="c" className="font-mono tabular">{formatUsd(step.actualCostUsd, { cents: true })}</span>],
              ["Runtime", <Runtime key="t" start={step.startedAt?.toISOString() ?? null} end={step.finishedAt?.toISOString() ?? null} className="font-mono tabular" />],
              ["Started", step.startedAt ? <RelTime key="st" date={step.startedAt} /> : "—"],
              ["Depends on", step.dependsOn.length ? step.dependsOn.join(", ") : "—"],
              ["Runs", String(runCounts[step.id] ?? 0)],
            ].map(([k, v]) => (
              <div key={k as string} className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-3">{k}</dt>
                <dd className="text-right text-fg">{v}</dd>
              </div>
            ))}
            <div>
              <dt className="mb-1 text-fg-3">Acceptance</dt>
              <dd>
                <ul className="space-y-1 text-fg-2">
                  {step.acceptance.length ? step.acceptance.map((a) => <li key={a}>· {a}</li>) : <li>—</li>}
                </ul>
              </dd>
            </div>
          </dl>
        </section>
      ) : (
        <p className="text-xs text-fg-3">Select a step in the graph to inspect its attempts, route and outputs.</p>
      )}
    </>
  );
}
