import { ArrowUpRight, CircleCheck, CircleDashed, CircleX, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Callout, RecChip, cn, formatPct, formatUsd } from "@gigpilot/ui";
import type { EconomicsBreakdown, ScoreGates } from "@gigpilot/db";
import { Dag } from "@/components/dag/dag";
import { RelTime } from "@/components/rel-time";
import { SampleBadge } from "@/components/sample/sample-badge";
import { StateBadge } from "@/components/state-badge";
import { fmtBudget, fmtDate } from "@/lib/format";
import { OPPORTUNITY_META, agentName, cleanMessage, isSystemEvent, routeId, routeLabel, serviceFamilyLabel, sourceName } from "@/lib/labels";
import type { OpportunityDetail } from "@/lib/queries/opportunity";
import { isSample } from "@/lib/sample";

/** Numbered section with mono eyebrow — hairline above, no box. */
export function Section({ n, title, meta, children, id, className, actions }: { n?: string; title: string; meta?: ReactNode; children: ReactNode; id?: string; className?: string; actions?: ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-6 border-t border-line pt-4", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="mb-3 flex items-baseline gap-2.5">
        {n ? <span className="eyebrow">{n}</span> : null}
        <h2 id={id ? `${id}-title` : undefined} className="text-[13px] font-semibold text-fg">
          {title}
        </h2>
        {meta ? <span className="truncate text-xs text-fg-3">{meta}</span> : null}
        {actions ? <span className="ml-auto">{actions}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function OppHeader({ d, size = "page" }: { d: OpportunityDetail; size?: "page" | "pane" }) {
  const o = d.opp;
  const meta = OPPORTUNITY_META[o.status];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-fg-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">{sourceName(o.sourceKey)}</span>
        {o.url ? (
          <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-0.5 text-fg-3 hover:text-fg" aria-label={`Open original listing on ${sourceName(o.sourceKey)} (new tab)`}>
            original <ArrowUpRight className="size-3" />
          </a>
        ) : null}
        <span aria-hidden>·</span>
        <span>{o.marketKey ? serviceFamilyLabel(o.marketKey) : (d.marketName ?? "Unclassified")}</span>
        <span aria-hidden>·</span>
        <span>
          posted <RelTime date={o.postedAt ?? o.createdAt} />
        </span>
        {isSample(o.createdAt, d.sampleBefore) ? <SampleBadge /> : null}
        <StateBadge meta={meta} className="ml-auto" dataStatus={o.status} testId="opp-status" />
      </div>
      <h1 data-testid="opp-title" className={cn("text-fg", size === "page" ? "font-display text-[22px] font-semibold leading-7 tracking-[-0.025em] md:text-[24px] md:leading-8" : "text-[16px] font-semibold leading-6 tracking-[-0.01em]")}>
        {o.title}
      </h1>
      <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-fg-3">
        <span className="text-fg-2">{o.clientName ?? "Unknown client"}</span>
        {o.clientCountry ? <span>{o.clientCountry}</span> : null}
        {o.clientRating ? <span>★ {o.clientRating.toFixed(1)}</span> : null}
        {o.clientSpendUsd ? <span>{formatUsd(o.clientSpendUsd)} spent on platform</span> : null}
        {o.proposalsCount !== null && o.proposalsCount !== undefined ? <span>{o.proposalsCount} proposals so far</span> : null}
      </p>
    </div>
  );
}

export function KeyNumbers({ d, variant = "page" }: { d: OpportunityDetail; variant?: "page" | "pane" }) {
  const o = d.opp;
  const e = d.estimate?.breakdown;
  const cells: { label: string; value: ReactNode; sub?: ReactNode; testId?: string; tone?: string }[] = [
    { label: "Budget", value: fmtBudget(o.budgetType, o.budgetMinUsd, o.budgetMaxUsd), sub: o.budgetType === "unknown" ? "not stated" : o.budgetType, testId: "opp-budget" },
    { label: "Price", value: e ? formatUsd(e.priceUsd) : "—", sub: e ? e.priceBasis.replace(/_/g, " ") : "not priced yet" },
    { label: "Exp. profit", value: e ? formatUsd(e.grossProfitUsd) : "—", sub: e ? `after ${formatUsd(e.totalCostUsd)} costs incl. owner time` : undefined, testId: "opp-expected-profit", tone: e ? (e.grossProfitUsd >= d.settings.thresholds.minExpectedProfitUsd ? "text-profit" : "text-risk") : undefined },
    { label: "Margin", value: e ? formatPct(e.grossMargin) : "—", sub: `after owner time · target ≥ ${formatPct(d.settings.thresholds.minGrossMargin)}`, testId: "opp-margin", tone: e ? (e.grossMargin >= d.settings.thresholds.minGrossMargin ? "text-profit" : "text-risk") : undefined },
    {
      label: "Recommendation",
      value: <RecChip rec={o.recommendation} pending={o.status === "analysing" ? "analysing" : "queued"} className="h-6 px-2 text-[12px]" />,
      sub: o.overallScore !== null ? `score ${Math.round(o.overallScore * 100)}` : "analysis running",
    },
  ];
  const shown = variant === "pane" ? cells.slice(0, 4) : cells;
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line", variant === "page" && "sm:grid-cols-5")}>
      {shown.map((c) => (
        <div key={c.label} className={cn("bg-bg px-3 py-2.5", variant === "page" && "last:col-span-2 sm:last:col-span-1")}>
          <dt className="text-[11px] text-fg-3">{c.label}</dt>
          <dd data-testid={c.testId} className={cn("mt-0.5 flex h-6 items-center truncate text-[16px] font-semibold tracking-[-0.01em] text-fg", c.tone)}>
            {c.value}
          </dd>
          {c.sub ? <dd className="text-[11px] leading-4 text-fg-3">{c.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function GateRow({ id, label, pass, detail, soft }: { id: string; label: string; pass: boolean | null; detail: ReactNode; soft?: boolean }) {
  return (
    <li className="flex items-center gap-2.5 py-1.5" data-testid={`gate-${id}`} data-pass={pass === null ? "false" : String(pass)}>
      {pass === null ? (
        <CircleDashed className="size-4 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
      ) : pass ? (
        <CircleCheck className="size-4 shrink-0 text-profit" strokeWidth={1.75} aria-hidden />
      ) : soft ? (
        <TriangleAlert className="size-4 shrink-0 text-warn" strokeWidth={1.75} aria-hidden />
      ) : (
        <CircleX className="size-4 shrink-0 text-risk" strokeWidth={1.75} aria-hidden />
      )}
      <span className="flex-1 text-[13px] text-fg">
        {label}
        <span className="sr-only">: {pass === null ? "not evaluated" : pass ? "pass" : "fail"}</span>
        {soft ? <span className="ml-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-3">soft</span> : null}
      </span>
      <span className="whitespace-nowrap font-mono text-[11.5px] tabular text-fg-2">{detail}</span>
    </li>
  );
}

/**
 * Business gates. "Estimate complete" reads the estimate itself (complete +
 * missing prices), never a cached gate, so it can't contradict the receipt.
 */
export function Gates({ gates, settings, estimate }: { gates: ScoreGates | null; settings: OpportunityDetail["settings"]; estimate?: EconomicsBreakdown | null }) {
  const t = settings.thresholds;
  const complete = estimate ? estimate.complete && estimate.missing.length === 0 : gates ? gates.complete.pass : null;
  const missingN = estimate?.missing.length ?? 0;
  return (
    <ul className="divide-y divide-line" aria-label="Business gates">
      <GateRow id="budget" label="Budget" soft pass={gates ? gates.budget.pass : null} detail={gates ? `${gates.budget.value === null ? "—" : formatUsd(gates.budget.value)} / ≥ ${formatUsd(t.preferredMinBudgetUsd)}` : `≥ ${formatUsd(t.preferredMinBudgetUsd)}`} />
      <GateRow id="profit" label="Expected profit" pass={gates ? gates.profit.pass : null} detail={gates ? `${formatUsd(gates.profit.value)} / ≥ ${formatUsd(gates.profit.threshold)}` : `≥ ${formatUsd(t.minExpectedProfitUsd)}`} />
      <GateRow id="margin" label="Gross margin" pass={gates ? gates.margin.pass : null} detail={gates ? `${formatPct(gates.margin.value)} / ≥ ${formatPct(gates.margin.threshold)}` : `≥ ${formatPct(t.minGrossMargin)}`} />
      <GateRow id="complete" label="Estimate complete" pass={complete} detail={complete === null ? "—" : complete ? "all prices known" : missingN ? `${missingN} unpriced` : "missing prices"} />
    </ul>
  );
}

export function BriefSection({ d, n = "01", clamp }: { d: OpportunityDetail; n?: string; clamp?: boolean }) {
  const o = d.opp;
  const a = d.analysis;
  return (
    <Section n={n} title="Brief" meta={d.capabilities?.attribution ? `via ${d.capabilities.attribution.name}` : `${sourceName(o.sourceKey)} · ${String((o.raw as { ingestion?: string } | null)?.ingestion ?? "api")} intake`} id="brief">
      {a ? (
        <p className="mb-3 text-[14px] leading-6 text-fg">{a.summary}</p>
      ) : (
        <Callout tone="info" icon={<CircleDashed />} className="mb-3">
          The Opportunity Analyst hasn’t finished yet — summary, scope and pricing appear here when analysis completes.
        </Callout>
      )}
      <details className="group rounded-sm bg-surface-1/60 ring-1 ring-inset ring-line" open={!clamp && !a}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-fg-2 hover:text-fg">
          <span>Original posting · {sourceName(o.sourceKey)}</span>
          <span className="font-mono text-[11px] text-fg-3 group-open:hidden">show</span>
          <span className="hidden font-mono text-[11px] text-fg-3 group-open:inline">hide</span>
        </summary>
        <div className="border-t border-line px-3 py-3">
          <p className="whitespace-pre-wrap text-[13px] leading-6 text-fg-2">{o.description}</p>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-3">
            <div>
              <dt className="inline">Posted </dt>
              <dd className="inline font-mono">{fmtDate(o.postedAt ?? o.createdAt)}</dd>
            </div>
            {o.deadlineAt ? (
              <div>
                <dt className="inline">Deadline </dt>
                <dd className="inline font-mono">{fmtDate(o.deadlineAt)}</dd>
              </div>
            ) : null}
            {o.skills.length ? (
              <div>
                <dt className="inline">Skills </dt>
                <dd className="inline">{o.skills.join(", ")}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline">External ID </dt>
              <dd className="inline font-mono">{o.externalId}</dd>
            </div>
          </dl>
          {o.url ? (
            <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-3 inline-flex items-center gap-1 text-xs text-info hover:underline">
              View on {sourceName(o.sourceKey)} <ArrowUpRight className="size-3" />
            </a>
          ) : null}
        </div>
      </details>
      {a?.clientRequest ? (
        <p className="mt-3 text-xs leading-5 text-fg-3">
          <span className="text-fg-2">Client asks for:</span> {a.clientRequest}
        </p>
      ) : null}
    </Section>
  );
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (x: string) => norm(x).split(" ").filter((w) => w.length >= 3 && !["and", "the", "for", "with", "option"].includes(w));
/** a ≈ contained in b when most of a's significant words appear in b. */
const mostlyIn = (a: string, b: string) => {
  const ta = tokens(a);
  if (!ta.length) return false;
  const tb = new Set(tokens(b));
  return ta.filter((w) => tb.has(w)).length / ta.length >= 0.75;
};

/** Missing = what the analyst flagged + every required asset the client hasn't supplied (required − supplied). */
export function missingInputsOf(a: { requiredAssets: string[]; suppliedAssets: string[]; missingInputs: string[] }): string[] {
  const out = [...a.missingInputs];
  for (const req of a.requiredAssets) {
    if (a.suppliedAssets.some((s) => mostlyIn(req, s) || mostlyIn(s, req))) continue;
    if (out.some((m) => mostlyIn(req, m))) continue;
    out.push(req);
  }
  return out;
}

export function ScopeSection({ d, n = "02" }: { d: OpportunityDetail; n?: string }) {
  const a = d.analysis;
  if (!a) return null;
  const missing = missingInputsOf(a);
  return (
    <Section n={n} title="Scope" meta={`${a.deliverables.length} deliverable${a.deliverables.length === 1 ? "" : "s"}${a.deadlineDays ? ` · ${a.deadlineDays}-day deadline` : ""}`} id="scope">
      <ul className="divide-y divide-line">
        {a.deliverables.map((x, i) => (
          <li key={i} className="flex items-baseline gap-3 py-1.5 text-[13px]">
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular text-fg-2">{x.quantity}×</span>
            <span className="min-w-0 flex-1 text-fg">{x.item}</span>
            {x.format ? <span className="shrink-0 font-mono text-[11px] text-fg-3">{x.format}</span> : null}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <AssetList title="Supplied by client" items={a.suppliedAssets} tone="profit" empty="Nothing supplied yet" />
        <AssetList title="Required to start" items={a.requiredAssets} tone="neutral" empty="No extra assets" />
        <AssetList title="Missing inputs" items={missing} tone="warn" empty="None — ready to start" />
      </div>
    </Section>
  );
}

function AssetList({ title, items, tone, empty }: { title: string; items: string[]; tone: "profit" | "neutral" | "warn"; empty: string }) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-fg-3">
        <span className={cn("size-1.5 rounded-full", tone === "profit" ? "bg-profit" : tone === "warn" ? "bg-warn" : "bg-fg-3")} aria-hidden />
        {title}
        <span className="font-mono">{items.length}</span>
      </p>
      {items.length ? (
        <ul className="space-y-1 text-[13px] text-fg-2">
          {items.map((x) => (
            <li key={x} className={cn(tone === "warn" && "text-fg")}>
              {x}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-3">{empty}</p>
      )}
    </div>
  );
}

type Coverage = NonNullable<EconomicsBreakdown["coverage"]>[number];

const INFERENCE_CAPS = /^(text\.|code\.|qa\.review$)/;

/** How a production unit is priced: the estimate's own coverage first, then the analysis hint, then the capability. */
function pricingOf(p: { label: string; capability: string; pricedVia?: string }, coverage: Coverage[] | undefined, route: { option: { provider: string; model: string } } | undefined): { text: string; warn?: boolean; title?: string } {
  const cov = coverage?.find((c) => c.label === p.label) ?? coverage?.find((c) => c.capability === p.capability);
  const via = cov?.pricedVia ?? p.pricedVia ?? (INFERENCE_CAPS.test(p.capability) ? "inference" : p.capability === "media.finishing" ? "local" : route ? "creative" : "unpriced");
  if (via === "inference") return { text: "Priced via inference", title: "Delivered by model calls — priced in the inference lines below" };
  if (via === "local") return { text: "Local tooling · $0" };
  if (via === "unpriced") return { text: "No priced route", warn: true, title: cov?.note ?? "No catalog route prices this capability yet — the estimate is marked incomplete" };
  const provider = cov?.provider ?? route?.option.provider ?? null;
  const model = cov?.model ?? route?.option.model ?? null;
  const label = routeLabel(provider, model);
  const simulated = cov?.routeStatus === "simulated" && label !== "Simulated";
  return { text: `${label}${simulated ? " (simulated)" : ""}`, title: [routeId(provider, model), cov?.note].filter(Boolean).join(" — ") || undefined, warn: cov?.routeStatus === "unavailable" };
}

function inferenceRoute(family: string): string {
  if (family === "gx") return "Local model · free";
  if (family === "grok") return "Grok · web research";
  if (family === "mock") return "Simulated";
  return "Cloud model · Factory";
}

export function PlanSection({ d, n = "03", compact }: { d: OpportunityDetail; n?: string; compact?: boolean }) {
  const a = d.analysis;
  if (!a) return null;
  const routeFor = (label: string) => d.routes.find((r) => r.label === label);
  const coverage = d.estimate?.breakdown?.coverage;
  const meta = d.analysisMeta;
  const stage = meta ? (meta.provider === "heuristic" ? "Preliminary triage" : `Deep analysis · ${routeLabel(meta.provider, meta.model)}`) : null;
  return (
    <Section n={n} title="Production plan" meta={stage ? <span title={meta ? routeId(meta.provider, meta.model) : undefined}>{`${stage} · v${meta!.version}`}</span> : undefined} id="plan">
      <Dag nodes={a.proposedWorkflow.map((s) => ({ key: s.key, name: s.name, agent: s.agent, kind: s.kind, dependsOn: s.dependsOn }))} compact label="Proposed workflow" />
      {!compact || a.productionEstimates.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[11px] uppercase tracking-[0.05em] text-fg-3">
                <th className="pb-1.5 font-medium">Estimate</th>
                <th className="pb-1.5 text-right font-medium">Units</th>
                <th className="pb-1.5 text-right font-medium">Attempts / unit</th>
                <th className="pb-1.5 pl-4 font-medium">Priced by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {a.productionEstimates.map((p) => {
                const pr = pricingOf(p, coverage, routeFor(p.label));
                return (
                  <tr key={p.label} className="h-8">
                    <td className="text-fg">{p.label}</td>
                    <td className="text-right font-mono text-xs tabular text-fg-2">{p.units}</td>
                    <td className="text-right font-mono text-xs tabular text-fg-2">{p.attemptsPerUnit.toFixed(1)}</td>
                    <td className={cn("pl-4 text-xs", pr.warn ? "text-warn" : "text-fg-2")} title={pr.title}>
                      {pr.text}
                    </td>
                  </tr>
                );
              })}
              {a.inferenceEstimates.map((x) => (
                <tr key={x.task} className="h-8">
                  <td className="text-fg">
                    {x.task} <span className="text-[11px] text-fg-3">· inference</span>
                  </td>
                  <td className="text-right font-mono text-xs tabular text-fg-2">{x.calls} calls</td>
                  <td className="text-right font-mono text-xs tabular text-fg-2">
                    {x.kTokensIn}k/{x.kTokensOut}k tok
                  </td>
                  <td className="pl-4 text-xs text-fg-2">{inferenceRoute(x.family)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {d.routes.length ? (
        <details className="mt-3 text-xs text-fg-3">
          <summary className="cursor-pointer select-none rounded-xs hover:text-fg-2">Why these creative routes</summary>
          <ul className="mt-1.5 space-y-1.5">
            {d.routes.map((r) => (
              <li key={r.label} className="flex gap-2 leading-5">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
                <span>
                  <span className="text-fg-2">{r.label}:</span> {r.rationale}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

function ReceiptRow({ label, value, sub, strong, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; strong?: boolean; tone?: string }) {
  return (
    <div className={cn("flex items-baseline gap-3 py-1.5", strong && "text-fg")}>
      <span className={cn("min-w-0 flex-1 text-[13px]", strong ? "font-medium text-fg" : "text-fg-2")}>
        {label}
        {sub ? <span className="ml-2 font-mono text-[11px] text-fg-3">{sub}</span> : null}
      </span>
      <span className={cn("shrink-0 font-mono text-[12.5px] tabular", strong ? "font-semibold" : "", tone ?? "text-fg")}>{value}</span>
    </div>
  );
}

export function EconomicsReceipt({ e, n = "04", sourceKey, compact }: { e: EconomicsBreakdown | null; n?: string; sourceKey: string; compact?: boolean }) {
  if (!e)
    return (
      <Section n={n} title="Economics" id="economics">
        <p className="text-xs text-fg-3">No estimate yet — the Economics agent prices the opportunity right after analysis.</p>
      </Section>
    );
  const fee = e.platformFeesUsd;
  return (
    <Section n={n} title="Economics" meta={e.complete ? "deterministic · catalog prices" : "incomplete estimate"} id="economics">
      {!e.complete ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="Incomplete estimate" className="mb-3">
          Unknown prices are never invented. Missing: {e.missing.join("; ")}. The opportunity can’t be recommended for pursuit until these are priced.
        </Callout>
      ) : null}
      {!compact ? (
        <div className="mb-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[11px] uppercase tracking-[0.05em] text-fg-3">
                <th className="pb-1.5 font-medium">Line item</th>
                <th className="pb-1.5 font-medium">Route</th>
                <th className="pb-1.5 text-right font-medium">Qty × attempts × unit</th>
                <th className="pb-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {e.lineItems.map((li, i) => (
                <tr key={i} className="h-8">
                  <td className="text-fg">
                    {li.label}
                    <Badge mono className="ml-2 align-middle">
                      {li.category}
                    </Badge>
                  </td>
                  <td className={cn("text-xs", li.provider ? "text-fg-3" : "text-warn")} title={[li.provider ? routeId(li.provider, li.model) : null, li.routeNote].filter(Boolean).join(" — ") || undefined}>
                    {li.provider ? routeLabel(li.provider, li.model) : "No priced route"}
                    {li.routeStatus === "simulated" && li.provider && routeLabel(li.provider, li.model) !== "Simulated" ? <span className="ml-1 text-fg-3">(simulated)</span> : null}
                  </td>
                  <td className="text-right font-mono text-xs tabular text-fg-2">
                    {Number(li.quantity.toFixed(2))} × {Number(li.attempts.toFixed(2))} × {li.unitCostUsd === null ? <span className="text-warn">unpriced</span> : formatUsd(li.unitCostUsd, { cents: true })}
                  </td>
                  <td className="text-right font-mono text-xs tabular text-fg">{li.totalUsd === null ? <span className="whitespace-nowrap text-warn">— unpriced</span> : formatUsd(li.totalUsd, { cents: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="divide-y divide-line border-t border-line">
        <ReceiptRow
          label="Fulfilment (production + inference)"
          value={formatUsd(e.fulfilmentCostUsd, { cents: true })}
          sub={`${e.lineItems.length} line items${e.lineItems.some((l) => l.totalUsd === null) ? ` · ${e.lineItems.filter((l) => l.totalUsd === null).length} unpriced, not included` : ""}`}
        />
        <ReceiptRow label="Revision contingency" value={formatUsd(e.revisionContingencyUsd, { cents: true })} />
        <ReceiptRow label="General contingency" value={formatUsd(e.contingencyUsd, { cents: true })} />
        <ReceiptRow label="Human shadow cost" value={formatUsd(e.shadowCostUsd, { cents: true })} sub="owner time" />
        <ReceiptRow label="Platform fees" value={formatUsd(fee, { cents: true })} sub={sourceName(e.platformFeeKey || sourceKey)} />
        <ReceiptRow label="Total cost" value={formatUsd(e.totalCostUsd, { cents: true })} strong />
        <ReceiptRow label="Price" value={formatUsd(e.priceUsd, { cents: true })} sub={e.priceBasis.replace(/_/g, " ")} />
        <ReceiptRow label="Profit after owner time" value={formatUsd(e.grossProfitUsd, { cents: true })} strong tone={e.grossProfitUsd >= 0 ? "text-profit" : "text-risk"} />
        <ReceiptRow label="Margin after owner time" value={formatPct(e.grossMargin, 1)} strong tone={e.grossMargin >= 0 ? "text-profit" : "text-risk"} />
        {e.priceUsd > 0 ? (
          <ReceiptRow label="Cash margin (ex. owner time)" value={formatPct((e.grossProfitUsd + e.shadowCostUsd) / e.priceUsd, 1)} sub="before valuing your time" tone="text-fg-2" />
        ) : null}
        <ReceiptRow label="Break-even price" value={formatUsd(e.breakEvenPriceUsd, { cents: true })} sub="profit = $0" />
      </div>
    </Section>
  );
}

export function RisksSection({ d, n = "05" }: { d: OpportunityDetail; n?: string }) {
  const risks = d.analysis?.risks ?? [];
  const s = d.score;
  return (
    <Section n={n} title="Risks" meta={`${risks.length} flagged`} id="risks">
      {s ? (
        <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
          {[
            ["Fit", s.fit, false],
            ["Complexity", s.complexity, true],
            ["Revision risk", s.revisionRisk, true],
            ["Deadline risk", s.deadlineRisk, true],
            ["Confidence", s.confidence, false],
          ].map(([label, v, invert]) => {
            const val = v as number;
            const good = invert ? 1 - val : val;
            return (
              <div key={label as string}>
                <dt className="text-[11px] text-fg-3">{label as string}</dt>
                <dd className="flex items-center gap-2">
                  <span className="font-mono text-[13px] tabular text-fg">{Math.round(val * 100)}</span>
                  <span className="relative h-1 flex-1 rounded-full bg-surface-3">
                    <span className={cn("absolute inset-y-0 left-0 rounded-full", good >= 0.66 ? "bg-profit" : good >= 0.4 ? "bg-warn" : "bg-risk")} style={{ width: `${val * 100}%` }} />
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {risks.length ? (
        <ul className="divide-y divide-line">
          {risks.map((r, i) => (
            <li key={i} className="flex items-baseline gap-3 py-1.5">
              <span className={cn("w-14 shrink-0 font-mono text-[11px] uppercase tracking-[0.06em]", r.severity === "high" ? "text-risk" : r.severity === "medium" ? "text-warn" : "text-fg-3")}>{r.severity}</span>
              <span className="w-20 shrink-0 text-xs text-fg-3">{r.kind}</span>
              <span className="min-w-0 flex-1 text-[13px] text-fg-2">{r.note}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-3">No risks flagged by the analyst.</p>
      )}
    </Section>
  );
}

export function RationaleSection({ d, n = "07", withEvents }: { d: OpportunityDetail; n?: string; withEvents?: boolean }) {
  const reasons = d.score?.reasons ?? [];
  const rationale = d.analysis?.rationale ?? [];
  const priorities = d.analysis?.buyerPriorities ?? [];
  return (
    <Section n={n} title="Rationale & evidence" meta="concise reasons — never raw model reasoning" id="rationale">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs text-fg-3">Why this recommendation</p>
          <ul className="space-y-1.5">
            {[...reasons, ...rationale].slice(0, 8).map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-5 text-fg-2">
                <span className="mt-[9px] size-1 shrink-0 rounded-full bg-fg-3" aria-hidden />
                {r}
              </li>
            ))}
            {reasons.length + rationale.length === 0 ? <li className="text-xs text-fg-3">Rationale appears after scoring.</li> : null}
          </ul>
        </div>
        <div>
          <p className="mb-1.5 text-xs text-fg-3">Buyer priorities</p>
          {priorities.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {priorities.map((p) => (
                <li key={p}>
                  <Badge>{p}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-3">—</p>
          )}
        </div>
      </div>
      {withEvents && d.events.some((e) => !isSystemEvent(e.type)) ? (
        <div className="mt-5">
          <p className="mb-2 text-xs text-fg-3">Evidence trail</p>
          <ol className="relative space-y-0.5 border-l border-line pl-4">
            {d.events.filter((e) => !isSystemEvent(e.type)).map((e) => (
              <li key={e.id} className="relative py-1">
                <span className={cn("absolute -left-[19.5px] top-[11px] size-[7px] rounded-full ring-2 ring-bg", e.level === "success" ? "bg-profit" : e.level === "warn" ? "bg-warn" : e.level === "error" ? "bg-risk" : "bg-fg-3")} aria-hidden />
                <p className="flex items-baseline gap-2 text-[13px] text-fg-2">
                  <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-3">{agentName(e.agent)}</span>
                  <span className="min-w-0 flex-1">{cleanMessage(e.message)}</span>
                  <RelTime date={e.createdAt} className="shrink-0 font-mono text-[11px] text-fg-3" />
                </p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Section>
  );
}
