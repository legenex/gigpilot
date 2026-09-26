import type { Metadata } from "next";
import Link from "next/link";
import { Receipt } from "lucide-react";
import { Badge, ColumnChart, DataTable, EmptyState, MetricStrip, Metric, SectionHeader, SegmentedControl, SplitBar, TBody, TD, TH, THead, TR, cn, formatPct, formatUsd } from "@gigpilot/ui";
import { AccuracyChart } from "@/components/costs/accuracy-chart";
import { PageHeader } from "@/components/page-header";
import { RelTime } from "@/components/rel-time";
import { UrlSelect } from "@/components/url-select";
import { COST_CATEGORY_META, SOURCE_SHORT } from "@/lib/labels";
import { getCosts, parseCostFilters, type CostFilters } from "@/lib/queries/costs";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Costs" };

const SERIES = [
  { key: "inference", label: "Inference", color: "var(--gp-series-1)" },
  { key: "creative", label: "Creative", color: "var(--gp-series-2)" },
  { key: "tool", label: "Tools & other", color: "var(--gp-series-3)" },
];

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireSession();
  const f = parseCostFilters(await searchParams);
  const data = await getCosts(ctx.tenantId, f);
  const t = data.totals;
  const profit = t.revenue - t.prodActual - t.fees;
  const margin = t.revenue > 0 ? profit / t.revenue : null;
  const limit = data.settings.limits.dailyPaidSpendLimitUsd;
  const qs = (patch: Partial<Record<keyof CostFilters, string | undefined>>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { category: f.category, kind: f.kind, paid: f.paid, days: f.days === 30 ? undefined : String(f.days), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/costs?${s}` : "/costs";
  };
  const chartData = data.daily.map((d) => ({
    label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    tick: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    values: { inference: d.inference, creative: d.creative, tool: d.tool },
  }));

  return (
    <div className="page">
      <PageHeader
        eyebrow="Costs"
        title="Every dollar, estimated and actual"
        description={`Last ${f.days} days · ${t.entries} ledger entries · paid spend ${formatUsd(t.prodPaid, { cents: true })} vs simulated ${formatUsd(t.prodSim, { cents: true })} · prices from the deterministic catalog`}
        actions={
          <SegmentedControl
            label="Range"
            value={String(f.days)}
            items={[7, 30, 90].map((d) => ({ value: String(d), label: `${d}d`, href: qs({ days: d === 30 ? undefined : String(d) }) }))}
          />
        }
      />

      <MetricStrip className="mb-7" columns={3}>
        <Metric label="Revenue (actual)" value={formatUsd(t.revenue)} sub={`${formatUsd(t.revenueEstimate)} contracted`} />
        <Metric label="Production cost · estimate" value={<span data-testid="costs-estimate-total">{formatUsd(t.prodEstimate, { cents: true })}</span>} sub="job estimates" />
        <Metric label="Production cost · actual" value={<span data-testid="costs-actual-total">{formatUsd(t.prodActual, { cents: true })}</span>} sub={t.prodEstimate > 0 ? `${formatPct(t.prodActual / t.prodEstimate)} of estimate` : "—"} />
        <Metric label="Marketplace fees" value={formatUsd(t.fees, { cents: true })} sub="actual, from settled jobs" />
        <Metric label="Gross profit" value={<span className={profit >= 0 ? "text-profit" : "text-risk"}>{formatUsd(profit)}</span>} sub={margin === null ? "no revenue yet" : `${formatPct(margin)} margin`} />
        <Metric
          label="Paid spend today"
          value={formatUsd(t.paidToday, { cents: true })}
          sub={limit > 0 ? `of ${formatUsd(limit, { cents: true })} daily limit` : <Link href="/settings#limits" className="text-warn hover:underline">limit $0 · paid providers off</Link>}
        />
      </MetricStrip>

      <div className="mb-8 grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section aria-labelledby="daily-title" className="min-w-0">
          <SectionHeader id="daily-title" title={`Daily production spend · ${f.days} days`} meta="actual, all providers (USD)" />
          <ColumnChart data={chartData} series={SERIES} height={200} label={`Daily production spend by category over ${f.days} days`} valueFormat="usd" emptyLabel="No spend recorded in this range" />
          <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 flex justify-between text-xs text-fg-3">
                <span>Paid vs simulated</span>
                <span className="font-mono">{t.prodActual > 0 ? formatPct(t.prodPaid / t.prodActual, 1) : "0%"} paid</span>
              </p>
              <SplitBar
                parts={[
                  { value: t.prodPaid, className: "bg-fg", label: `Paid ${formatUsd(t.prodPaid, { cents: true })}` },
                  { value: t.prodSim, className: "bg-fg-4", label: `Simulated ${formatUsd(t.prodSim, { cents: true })}` },
                ]}
              />
              <p className="mt-2 flex gap-4 text-[11px] text-fg-3">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-fg" aria-hidden /> Paid {formatUsd(t.prodPaid, { cents: true })}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-fg-4" aria-hidden /> Simulated (mock) {formatUsd(t.prodSim, { cents: true })}
                </span>
              </p>
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
              {[
                ["inference", t.inference],
                ["creative", t.creative],
                ["tool", t.tool],
              ].map(([k, v]) => (
                <div key={k as string} className="contents">
                  <dt className="flex items-center gap-2 text-fg-2">
                    <span className="size-2 rounded-[2px]" style={{ background: COST_CATEGORY_META[k as string]?.color }} aria-hidden />
                    {k === "tool" ? "Tools & other" : COST_CATEGORY_META[k as string]?.label}
                  </dt>
                  <dd className="text-right font-mono tabular text-fg">{formatUsd(v as number, { cents: true })}</dd>
                </div>
              ))}
              <dt className="mt-1 border-t border-line pt-1 text-fg-3">Human shadow (est.)</dt>
              <dd className="mt-1 border-t border-line pt-1 text-right font-mono tabular text-fg-3">{formatUsd(t.shadowEstimate)}</dd>
            </dl>
          </div>
        </section>

        <section aria-labelledby="accuracy-title" className="min-w-0">
          <SectionHeader id="accuracy-title" title="Estimate vs actual · per job" meta={`target ±${data.settings.goals.costEstimateAccuracyPct}%`} />
          <AccuracyChart rows={data.jobs.filter((j) => j.act > 0).map((j) => ({ id: j.id, title: j.title, est: j.est, act: j.act, done: ["awaiting_final_approval", "delivered", "closed"].includes(j.status) }))} targetPct={data.settings.goals.costEstimateAccuracyPct} />
        </section>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-8 2xl:grid-cols-2">
        <section aria-labelledby="perjob-title" className="min-w-0">
          <SectionHeader id="perjob-title" title="Per job" meta="revenue, cost and margin" />
          <DataTable label="Per-job totals" minWidth={560}>
            <THead>
              <tr>
                <TH>Job</TH>
                <TH align="right">Revenue</TH>
                <TH align="right">Est.</TH>
                <TH align="right">Actual</TH>
                <TH align="right">Fees</TH>
                <TH align="right">Profit</TH>
                <TH align="right">Margin</TH>
              </tr>
            </THead>
            <TBody>
              {data.jobs.map((j) => {
                const p = j.price - j.act - j.fees;
                return (
                  <TR key={j.id}>
                    <TD className="max-w-[220px]">
                      <Link href={`/jobs/${j.id}`} className="block truncate text-fg hover:underline">
                        {j.title}
                      </Link>
                    </TD>
                    <TD num>{formatUsd(j.price)}</TD>
                    <TD num className="text-fg-3">{formatUsd(j.est, { cents: true })}</TD>
                    <TD num>
                      {formatUsd(j.act, { cents: true })}
                      {j.paid > 0 ? <span className="ml-1 text-[10px] text-warn">paid</span> : null}
                    </TD>
                    <TD num className="text-fg-3">{j.fees ? formatUsd(j.fees, { cents: true }) : "—"}</TD>
                    <TD num className={p >= 0 ? "text-profit" : "text-risk"}>{formatUsd(p)}</TD>
                    <TD num className="text-fg-2">{j.price > 0 ? formatPct(p / j.price) : "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </DataTable>
        </section>
        <section aria-labelledby="peropp-title" className="min-w-0">
          <SectionHeader id="peropp-title" title="Per opportunity" meta="open pipeline estimates" />
          <DataTable label="Per-opportunity estimates" minWidth={560}>
            <THead>
              <tr>
                <TH>Opportunity</TH>
                <TH align="right">Price</TH>
                <TH align="right">Est. cost</TH>
                <TH align="right">Fees</TH>
                <TH align="right">Profit</TH>
                <TH align="right">Margin</TH>
                <TH align="right" title="Actual analysis/proposal spend so far">Spent</TH>
              </tr>
            </THead>
            <TBody>
              {data.opps.map((o) => (
                <TR key={o.id}>
                  <TD className="max-w-[220px]">
                    <Link href={`/radar/${o.id}`} className="block truncate text-fg hover:underline">
                      {o.title}
                    </Link>
                    <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-fg-3">
                      {SOURCE_SHORT[o.sourceKey] ?? o.sourceKey} · {o.status}
                    </span>
                  </TD>
                  <TD num>{formatUsd(o.price)}</TD>
                  <TD num className="text-fg-3">{formatUsd(o.est)}</TD>
                  <TD num className="text-fg-3">{formatUsd(o.fees)}</TD>
                  <TD num className="text-profit">
                    {o.complete ? "" : <span className="text-warn">≈</span>}
                    {formatUsd(o.profit)}
                  </TD>
                  <TD num className="text-fg-2">{formatPct(o.margin)}</TD>
                  <TD num className="text-fg-3">{formatUsd(o.spent, { cents: true })}</TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        </section>
      </div>

      <section aria-labelledby="ledger-title">
        <SectionHeader id="ledger-title" title="Ledger" meta={`${data.ledger.length} most recent entries`} />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <UrlSelect
            param="category"
            label="Category"
            value={f.category ?? ""}
            className="w-[170px]"
            options={[{ value: "", label: "All categories" }, ...Object.entries(COST_CATEGORY_META).map(([k, v]) => ({ value: k, label: v.label }))]}
          />
          <SegmentedControl
            label="Kind"
            value={f.kind ?? "all"}
            items={[
              { value: "all", label: "All", href: qs({ kind: undefined }) },
              { value: "actual", label: "Actual", href: qs({ kind: "actual" }) },
              { value: "estimate", label: "Estimate", href: qs({ kind: "estimate" }) },
            ]}
          />
          <SegmentedControl
            label="Billing"
            value={f.paid ?? "all"}
            items={[
              { value: "all", label: "Paid + simulated", href: qs({ paid: undefined }) },
              { value: "paid", label: "Paid", href: qs({ paid: "paid" }) },
              { value: "sim", label: "Simulated", href: qs({ paid: "sim" }) },
            ]}
          />
        </div>
        {data.ledger.length === 0 ? (
          <EmptyState icon={<Receipt />} title="No ledger entries match" description="Every agent run, generation, fee and payment writes a ledger entry. Widen the range or clear filters." />
        ) : (
          <DataTable label="Cost ledger" minWidth={980} className="rounded-md ring-1 ring-inset ring-line">
            <THead sticky>
              <tr>
                <TH>When</TH>
                <TH>Category</TH>
                <TH>Memo</TH>
                <TH>Provider</TH>
                <TH>Subject</TH>
                <TH>Kind</TH>
                <TH>Billing</TH>
                <TH align="right">Amount</TH>
              </tr>
            </THead>
            <TBody>
              {data.ledger.map((l) => (
                <TR key={l.id} data-testid="ledger-row" data-kind={l.kind} data-category={l.category}>
                  <TD className="text-xs text-fg-3">
                    <RelTime date={l.createdAt} />
                  </TD>
                  <TD>
                    <span className="inline-flex items-center gap-2 text-xs text-fg-2">
                      <span className="size-2 rounded-[2px]" style={{ background: COST_CATEGORY_META[l.category]?.color }} aria-hidden />
                      {COST_CATEGORY_META[l.category]?.label ?? l.category}
                    </span>
                  </TD>
                  <TD className="max-w-[280px] truncate text-fg-2" title={l.memo}>
                    {l.memo || "—"}
                  </TD>
                  <TD className="font-mono text-[11px] text-fg-3">{l.provider ? `${l.provider}${l.model ? `/${l.model}` : ""}` : "—"}</TD>
                  <TD className="max-w-[220px] truncate text-xs">
                    {l.jobId ? (
                      <Link href={`/jobs/${l.jobId}`} className="text-fg-2 hover:text-fg hover:underline">
                        {l.jobTitle ?? "Job"}
                      </Link>
                    ) : l.opportunityId ? (
                      <Link href={`/radar/${l.opportunityId}`} className="text-fg-3 hover:text-fg hover:underline">
                        {l.oppTitle ?? "Opportunity"}
                      </Link>
                    ) : (
                      <span className="text-fg-3">Workspace</span>
                    )}
                  </TD>
                  <TD>
                    <Badge mono tone={l.kind === "actual" ? "neutral" : "info"} className="h-[18px] text-[10px]">
                      {l.kind}
                    </Badge>
                  </TD>
                  <TD>
                    <span className={cn("text-xs", l.paid ? "text-warn" : "text-fg-3")}>{l.category === "revenue" ? (l.paid ? "received" : "contracted") : l.paid ? "paid" : "simulated"}</span>
                  </TD>
                  <TD num className={l.category === "revenue" ? "text-profit" : "text-fg"}>
                    {l.category === "revenue" ? "+" : ""}
                    {formatUsd(l.amountUsd, { cents: true })}
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </section>
    </div>
  );
}
