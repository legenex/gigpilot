import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ChevronLeft, CircleCheck, CircleX, Download, FileArchive, FileText, Wrench } from "lucide-react";
import { BarMeter, Button, Callout, SectionHeader, StatusDot, cn, formatPct, formatUsd } from "@gigpilot/ui";
import type { JobState } from "@gigpilot/contracts";
import { Dag, type DagRepair } from "@/components/dag/dag";
import { JobActions } from "@/components/jobs/job-actions";
import { ActivityStream } from "@/components/live/activity-stream";
import { RelTime } from "@/components/rel-time";
import { StateBadge } from "@/components/state-badge";
import { fmtDate, isPast } from "@/lib/format";
import { COST_CATEGORY_META, DELIVERY_META, JOB_META, RUN_META, SOURCE_SHORT, agentName } from "@/lib/labels";
import { getJobDetail } from "@/lib/queries/jobs";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Job" };

const UUID = /^[0-9a-f-]{36}$/i;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await requireSession();
  const d = await getJobDetail(ctx.tenantId, id);
  if (!d) notFound();
  const j = d.job;
  const meta = JOB_META[j.status as JobState];
  const spendPct = j.spendLimitUsd > 0 ? j.actualCostUsd / j.spendLimitUsd : 0;
  const variance = j.estimatedCostUsd > 0 ? j.actualCostUsd / j.estimatedCostUsd - 1 : null;
  const complete = ["awaiting_final_approval", "delivered", "closed"].includes(j.status);
  const fees = d.ledger.filter((l) => l.category === "marketplace_fee" && l.kind === "actual").reduce((s, l) => s + l.total, 0);
  const profit = j.priceUsd - j.actualCostUsd - fees;
  const images = d.assets.filter((a) => a.kind === "image");
  const files = d.assets.filter((a) => a.kind !== "image" && a.id !== d.delivery?.packageAssetId);
  const pkg = d.delivery?.packageAssetId ? d.assets.find((a) => a.id === d.delivery!.packageAssetId) : null;
  const stepByKey = new Map(d.steps.map((s) => [s.key, s]));
  const stepById = new Map(d.steps.map((s) => [s.id, s]));
  const qaStep = d.steps.find((s) => s.kind === "qa");
  const repairs: DagRepair[] = qaStep
    ? d.repairs
        .filter((r) => r.stepId && stepById.has(r.stepId))
        .map((r, i, arr) => ({ fromKey: qaStep.key, toKey: stepById.get(r.stepId!)!.key, label: `${r.strategy} ${arr.length - i}`, status: r.status }))
    : [];
  const runningRuns = d.runs.filter((r) => r.status === "running");

  // Estimate vs actual by category
  const cats = ["creative", "inference", "tool", "subcontractor", "human_shadow", "marketplace_fee"];
  const byCat = cats
    .map((c) => ({
      c,
      est: d.ledger.filter((l) => l.category === c && l.kind === "estimate").reduce((s, l) => s + l.total, 0),
      act: d.ledger.filter((l) => l.category === c && l.kind === "actual").reduce((s, l) => s + l.total, 0),
      paid: d.ledger.filter((l) => l.category === c && l.kind === "actual" && l.paid).reduce((s, l) => s + l.total, 0),
    }))
    .filter((x) => x.est > 0 || x.act > 0);

  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="mb-4">
        <Link href="/jobs" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
          <ChevronLeft className="size-3.5" /> Jobs
        </Link>
      </nav>

      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-fg-3">
            <span className="text-fg-2">{d.client?.name ?? "Client"}</span>
            <span aria-hidden>·</span>
            <span>{j.serviceFamily.replace(/-/g, " ")}</span>
            {d.opportunity ? (
              <>
                <span aria-hidden>·</span>
                <Link href={`/radar/${d.opportunity.id}`} className="inline-flex items-center gap-0.5 hover:text-fg">
                  {SOURCE_SHORT[d.opportunity.sourceKey] ?? d.opportunity.sourceKey} opportunity <ArrowUpRight className="size-3" />
                </Link>
              </>
            ) : null}
            <span aria-hidden>·</span>
            {isPast(j.dueAt) && !complete ? (
              <span className="text-warn">
                overdue · due <RelTime date={j.dueAt} />
              </span>
            ) : (
              <span>due {j.dueAt ? <RelTime date={j.dueAt} /> : "—"}</span>
            )}
          </p>
          <h1 className="font-display text-[22px] font-semibold leading-7 tracking-[-0.025em] text-fg md:text-[24px] md:leading-8">{j.title}</h1>
          <div className="mt-2 flex items-center gap-3">
            <span data-testid="job-status" data-status={j.status}>
              <StateBadge meta={meta} />
            </span>
            {runningRuns.length ? (
              <span className="flex items-center gap-1.5 text-xs text-fg-2">
                <StatusDot tone="info" live /> {runningRuns.map((r) => agentName(r.agent)).join(", ")} working
              </span>
            ) : null}
          </div>
        </div>
        <JobActions
          jobId={j.id}
          status={j.status}
          deliveryStatus={d.delivery?.status ?? null}
          fileCount={d.delivery?.manifest?.items.length ?? d.assets.length}
          qaSummary={d.delivery?.manifest?.qaSummary ?? d.qas[0]?.summary ?? null}
          priceUsd={j.priceUsd}
          repairsLeft={Math.max(0, d.settings.limits.maxRepairsPerJob - j.repairCount)}
        />
      </header>

      {j.status === "awaiting_final_approval" && d.delivery?.status === "prepared" ? (
        <Callout tone="accent" icon={<CircleCheck />} title="Final delivery is ready for your review" className="mb-5">
          {d.delivery.manifest?.qaSummary ?? "QA passed."} Download the package below, then approve or request changes. Nothing reaches the client before you approve.
        </Callout>
      ) : null}

      <dl className="mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line sm:grid-cols-3 xl:grid-cols-6">
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Contract</dt>
          <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] text-fg">{formatUsd(j.priceUsd)}</dd>
          <dd className="text-[11px] text-fg-3">{d.application?.submissionMode === "api" ? "via marketplace API" : "manual application"}</dd>
        </div>
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Spend vs limit</dt>
          <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] text-fg">{formatPct(spendPct)}</dd>
          <dd className="mt-1.5">
            <BarMeter value={spendPct} tone={spendPct > 0.9 ? "risk" : spendPct > 0.7 ? "warn" : "neutral"} label="Spend against job limit" />
          </dd>
          <dd className="mt-1 font-mono text-[11px] text-fg-3">limit {formatUsd(j.spendLimitUsd, { cents: true })}</dd>
        </div>
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Estimated cost</dt>
          <dd data-testid="job-estimated-cost" className="mt-0.5 font-mono text-[18px] font-semibold tabular text-fg">
            {formatUsd(j.estimatedCostUsd, { cents: true })}
          </dd>
          <dd className="text-[11px] text-fg-3">fulfilment + contingencies</dd>
        </div>
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Actual cost</dt>
          <dd data-testid="job-actual-cost" className="mt-0.5 font-mono text-[18px] font-semibold tabular text-fg">
            {formatUsd(j.actualCostUsd, { cents: true })}
          </dd>
          <dd className={cn("font-mono text-[11px]", variance !== null && complete && Math.abs(variance) > d.settings.goals.costEstimateAccuracyPct / 100 ? "text-warn" : "text-fg-3")}>
            {variance === null ? "—" : `${variance >= 0 ? "+" : "−"}${Math.abs(Math.round(variance * 100))}% vs estimate${complete ? "" : " so far"}`}
          </dd>
        </div>
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Gross profit</dt>
          <dd className={cn("mt-0.5 text-[20px] font-semibold tracking-[-0.02em]", profit >= 0 ? "text-profit" : "text-risk")}>{formatUsd(profit)}</dd>
          <dd className="text-[11px] text-fg-3">{formatPct(j.priceUsd > 0 ? profit / j.priceUsd : 0)} margin{fees ? ` after ${formatUsd(fees)} fees` : ""}</dd>
        </div>
        <div className="bg-bg px-4 py-3">
          <dt className="text-xs text-fg-3">Repairs</dt>
          <dd className={cn("mt-0.5 text-[20px] font-semibold tracking-[-0.02em]", j.repairCount ? "text-warn" : "text-fg")}>
            {j.repairCount}
            <span className="text-[13px] font-medium text-fg-3"> / {d.settings.limits.maxRepairsPerJob}</span>
          </dd>
          <dd className="text-[11px] text-fg-3">max {d.settings.limits.maxStepAttempts} attempts per step</dd>
        </div>
      </dl>

  <section aria-labelledby="dag-title" className="mb-8">
        <SectionHeader
          id="dag-title"
          eyebrow="01"
          title="Production workflow"
          meta={d.workflow ? `v${d.workflow.version} · ${d.steps.filter((s) => s.status === "succeeded").length}/${d.steps.length} steps done · planned by ${agentName(d.workflow.plannedBy)}` : "not planned yet"}
          actions={
            <Link href={`/production?job=${j.id}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
              Inspect in Production <ArrowUpRight className="size-3" />
            </Link>
          }
        />
        {d.steps.length ? (
          <Dag
            nodes={d.steps.map((s) => ({
              key: s.key,
              name: s.name,
              agent: s.agent,
              kind: s.kind,
              dependsOn: s.dependsOn.filter((k) => stepByKey.has(k)),
              status: s.status,
              provider: s.provider,
              model: s.model,
              attempts: s.attempts,
              maxAttempts: s.maxAttempts,
              costUsd: s.actualCostUsd,
              estimatedCostUsd: s.estimatedCostUsd,
            }))}
            repairs={repairs}
            hrefs={Object.fromEntries(d.steps.map((s) => [s.key, `/production?job=${j.id}&step=${s.key}`]))}
          />
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-fg-2">
            <StatusDot tone="info" live={j.status === "planning" || j.status === "intake"} />
            The Production Planner is turning the accepted scope into a workflow.
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-8">

          <section aria-labelledby="qa-title">
            <SectionHeader id="qa-title" eyebrow="02" title="QA reviews" meta={d.qas.length ? `${d.qas.length} review${d.qas.length === 1 ? "" : "s"} · independent evaluator` : "none yet"} />
            {d.qas.length === 0 ? (
              <p className="text-xs text-fg-3">The QA Evaluator reviews outputs against the brief and acceptance criteria before anything is packaged.</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {d.qas.map((q) => (
                  <li key={q.id} data-testid="qa-review" data-verdict={q.verdict} className={cn("rounded-md p-3.5 ring-1 ring-inset", q.verdict === "pass" ? "ring-line" : "ring-risk/30")}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", q.verdict === "pass" ? "text-profit" : "text-risk")}>
                        {q.verdict === "pass" ? <CircleCheck className="size-4" strokeWidth={1.75} /> : <CircleX className="size-4" strokeWidth={1.75} />}
                        {q.verdict === "pass" ? "Pass" : "Fail"}
                      </span>
                      <span className="font-mono text-xs tabular text-fg">{q.score.toFixed(2)}</span>
                      <span className="font-mono text-[11px] text-fg-3">
                        attempt {q.attempt} · {q.provider}/{q.model}
                      </span>
                      <RelTime date={q.createdAt} className="ml-auto font-mono text-[11px] text-fg-3" />
                    </div>
                    <p className="mt-1.5 text-[13px] text-fg-2">{q.summary}</p>
                    {q.findings.length ? (
                      <ul className="mt-2.5 divide-y divide-line border-t border-line">
                        {q.findings.map((f, i) => (
                          <li key={i} className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 py-2 text-[13px]">
                            <span className={cn("font-mono text-[10.5px] uppercase tracking-[0.06em]", f.severity === "critical" ? "text-risk" : f.severity === "major" ? "text-warn" : "text-fg-3")}>{f.severity}</span>
                            <span className="text-fg-2">
                              {f.message}
                              {f.criterion ? <span className="ml-1.5 text-xs text-fg-3">· {f.criterion}</span> : null}
                              {f.repairHint ? <span className="mt-0.5 block text-xs text-fg-3">Repair hint: {f.repairHint}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="repairs-title">
            <SectionHeader id="repairs-title" eyebrow="03" title="Repairs" meta={`${d.repairs.length} of ${d.settings.limits.maxRepairsPerJob} allowed`} />
            {d.repairs.length === 0 ? (
              <p className="text-xs text-fg-3">No repairs needed so far.</p>
            ) : (
              <ol className="divide-y divide-line">
                {d.repairs.map((r) => (
                  <li key={r.id} data-testid="repair-item" className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-baseline gap-x-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.05em] text-warn">
                      <Wrench className="size-3" /> {r.strategy}
                    </span>
                    <span className="text-[13px] text-fg-2">
                      {r.rationale}
                      <span className="mt-0.5 block font-mono text-[11px] text-fg-3">
                        attempt {r.attempt}
                        {r.stepId && stepById.get(r.stepId) ? ` · ${stepById.get(r.stepId)!.name}` : ""} · <RelTime date={r.createdAt} />
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-mono text-xs tabular text-fg">+{formatUsd(r.incrementalCostUsd, { cents: true })}</span>
                      <span className={cn("inline-flex items-center gap-1 text-[11px]", r.status === "succeeded" ? "text-profit" : r.status === "failed" || r.status === "blocked" ? "text-risk" : "text-info")}>
                        <StatusDot tone={r.status === "succeeded" ? "profit" : r.status === "failed" || r.status === "blocked" ? "risk" : "info"} live={r.status === "running"} />
                        {r.status}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="assets-title">
            <SectionHeader id="assets-title" eyebrow="04" title="Assets" meta={`${d.assets.length} file${d.assets.length === 1 ? "" : "s"} · served through authenticated routes`} />
            {d.assets.length === 0 ? (
              <p className="text-xs text-fg-3">Generated assets appear here as steps complete.</p>
            ) : (
              <>
                {images.length ? (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {images.map((a) => (
                      <li key={a.id}>
                        <a href={`/api/assets/${a.id}`} target="_blank" rel="noopener" className="group block overflow-hidden rounded-sm bg-surface-1 ring-1 ring-inset ring-line hover:ring-line-bright">
                          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated asset route, not a static image */}
                          <img src={`/api/assets/${a.id}`} alt={a.filename} loading="lazy" className="aspect-[4/5] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />
                        </a>
                        <p className="mt-1.5 truncate font-mono text-[10.5px] text-fg-3" title={a.filename}>
                          {a.filename}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {files.length ? (
                  <ul className="mt-4 divide-y divide-line border-t border-line">
                    {files.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 py-2">
                        <FileText className="size-4 text-fg-3" strokeWidth={1.75} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{a.filename}</span>
                        <span className="font-mono text-[11px] text-fg-3">{fmtBytes(a.bytes)}</span>
                        <a href={`/api/assets/${a.id}?download=1`} className="text-xs text-fg-3 hover:text-fg">
                          Download
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </section>

          <section aria-labelledby="delivery-title">
            <SectionHeader id="delivery-title" eyebrow="05" title="Delivery package" meta={d.delivery ? DELIVERY_META[d.delivery.status]?.label : "not prepared"} />
            {d.delivery ? (
              <div className="rounded-md ring-1 ring-inset ring-line">
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
                  <FileArchive className="size-5 text-fg-3" strokeWidth={1.5} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg">{pkg?.filename ?? "delivery package"}</p>
                    <p className="font-mono text-[11px] text-fg-3">
                      {d.delivery.manifest?.items.length ?? 0} files{pkg ? ` · ${fmtBytes(pkg.bytes)}` : ""} · prepared {fmtDate(d.delivery.createdAt)}
                      {d.delivery.approvedAt ? ` · approved ${fmtDate(d.delivery.approvedAt)}` : ""}
                    </p>
                  </div>
                  {pkg ? (
                    <Button asChild variant="secondary" size="sm">
                      <a href={`/api/assets/${pkg.id}?download=1`} data-testid="job-delivery-download">
                        <Download className="size-3.5" /> Download package
                      </a>
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1.5 text-xs text-fg-3">Manifest</p>
                    <ul className="space-y-1">
                      {(d.delivery.manifest?.items ?? []).map((it) => (
                        <li key={it.assetId} className="flex justify-between gap-3 font-mono text-[11.5px]">
                          <span className="truncate text-fg-2">{it.filename}</span>
                          <span className="shrink-0 text-fg-3">{fmtBytes(it.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                    {d.delivery.manifest?.notes ? <p className="mt-3 text-xs text-fg-3">{d.delivery.manifest.notes}</p> : null}
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs text-fg-3">Client message (draft — not sent automatically)</p>
                    <p className="whitespace-pre-wrap rounded-sm bg-surface-1 p-3 text-[13px] leading-6 text-fg-2">{d.delivery.clientMessage ?? "—"}</p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-fg-3">Media Finishing packages the approved outputs after QA passes.</p>
            )}
            {d.revisions.length ? (
              <div className="mt-4">
                <p className="mb-1.5 text-xs text-fg-3">Revisions</p>
                <ul className="divide-y divide-line border-t border-line">
                  {d.revisions.map((r) => (
                    <li key={r.id} className="py-2 text-[13px]">
                      <p className="text-fg">“{r.request}”</p>
                      <p className="mt-0.5 text-xs text-fg-3">
                        {r.interpretation ?? "Awaiting interpretation"} · {r.inScope === false ? `change order ${formatUsd(r.changeOrderUsd)}` : "in scope"} · {r.status}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-7" aria-label="Job context">
          <section aria-labelledby="brief-title">
            <SectionHeader id="brief-title" title="Brief" />
            <p className="text-[13px] leading-6 text-fg-2">{j.brief || "—"}</p>
            <p className="mb-1.5 mt-4 text-xs text-fg-3">Acceptance criteria</p>
            <ul className="space-y-1.5">
              {j.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-5 text-fg-2">
                  <CircleCheck className={cn("mt-0.5 size-3.5 shrink-0", complete ? "text-profit" : "text-fg-4")} strokeWidth={1.75} aria-label={complete ? "met" : "pending"} />
                  {c}
                </li>
              ))}
              {j.acceptanceCriteria.length === 0 ? <li className="text-xs text-fg-3">Criteria come from the analysis and workflow plan.</li> : null}
            </ul>
          </section>

          <section aria-labelledby="cost-title">
            <SectionHeader id="cost-title" title="Estimate vs actual" meta="from the cost ledger" />
            {byCat.length ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3">
                    <th className="pb-1 text-left font-medium">Category</th>
                    <th className="pb-1 text-right font-medium">Estimate</th>
                    <th className="pb-1 text-right font-medium">Actual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {byCat.map((x) => (
                    <tr key={x.c} className="h-8">
                      <td className="text-fg-2">
                        <span className="mr-2 inline-block size-2 rounded-[2px] align-middle" style={{ background: COST_CATEGORY_META[x.c]?.color }} aria-hidden />
                        {COST_CATEGORY_META[x.c]?.label ?? x.c}
                      </td>
                      <td className="text-right font-mono tabular text-fg-3">{x.est ? formatUsd(x.est, { cents: true }) : "—"}</td>
                      <td className="text-right font-mono tabular text-fg">
                        {x.act ? formatUsd(x.act, { cents: true }) : "—"}
                        {x.act ? <span className={cn("ml-1.5 text-[10px]", x.paid ? "text-warn" : "text-fg-3")}>{x.paid >= x.act ? "paid" : x.paid ? "mixed" : "sim"}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-fg-3">No ledger entries yet.</p>
            )}
            <p className="mt-2 text-[11px] text-fg-3">“sim” = simulated (mock provider, no money spent). “paid” = billed by a real provider.</p>
          </section>

          <section aria-labelledby="runs-title">
            <SectionHeader
              id="runs-title"
              title="Agent runs"
              meta={`${d.runs.length} recorded`}
              actions={
                <Link href={`/agents?job=${j.id}`} className="text-xs text-fg-3 hover:text-fg">
                  All
                </Link>
              }
            />
            <ul className="divide-y divide-line">
              {d.runs.slice(0, 8).map((r) => {
                const rm = RUN_META[r.status];
                return (
                  <li key={r.id} className="flex items-center gap-2.5 py-1.5 text-xs">
                    <StatusDot tone={rm.tone} live={rm.live} />
                    <span className="min-w-0 flex-1 truncate text-fg-2">
                      <span className="text-fg">{agentName(r.agent)}</span> · {r.task}
                    </span>
                    {r.attempt > 1 ? <span className="font-mono text-[10.5px] text-warn">#{r.attempt}</span> : null}
                    <span className="font-mono text-[10.5px] text-fg-3">{formatUsd(r.costUsd, { cents: true })}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="job-activity-title">
            <SectionHeader id="job-activity-title" title="Activity" meta="live" />
            <div className="-mx-1.5 max-h-[420px] overflow-y-auto">
              <ActivityStream initial={d.events} filter={{ jobId: j.id }} limit={30} dense emptyText="No events for this job yet." />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
