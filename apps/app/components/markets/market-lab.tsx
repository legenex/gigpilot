"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Scale, Sparkles } from "lucide-react";
import { Button, Callout, Input, Slider, Switch, Tooltip, cn, formatPct, formatUsd } from "@gigpilot/ui";
import type { MarketInsight } from "@gigpilot/contracts";
import { RelTime } from "@/components/rel-time";
import { applyRecommendationAction, saveAllocationsAction, setMarketEnabledAction } from "@/lib/actions/markets";
import type { MarketRow } from "@/lib/queries/markets";
import { useAction } from "@/lib/use-action";

interface InsightView {
  id: string;
  headline: string;
  summary: string;
  body: MarketInsight;
  provider: string;
  model: string;
  createdAt: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function Trend({ t }: { t: "up" | "down" | "flat" | null }) {
  if (!t) return <span className="text-fg-3">—</span>;
  const Icon = t === "up" ? ArrowUpRight : t === "down" ? ArrowDownRight : Minus;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs", t === "up" ? "text-profit" : t === "down" ? "text-risk" : "text-fg-3")}>
      <Icon className="size-3.5" strokeWidth={1.75} />
      {t}
    </span>
  );
}

function Ratio({ v, invert, neutral }: { v: number | null; invert?: boolean; neutral?: boolean }) {
  if (v === null) return <span className="text-fg-3">—</span>;
  const good = invert ? 1 - v : v;
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="font-mono text-xs tabular text-fg-2">{formatPct(v)}</span>
      <span className="relative h-[3px] w-6 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className={cn("absolute inset-y-0 left-0 rounded-full", neutral ? "bg-fg-2" : good >= 0.66 ? "bg-profit" : good >= 0.4 ? "bg-warn" : "bg-risk")} style={{ width: `${Math.min(1, neutral ? v / 0.4 : v) * 100}%` }} />
      </span>
    </span>
  );
}

export function MarketLab({ markets, insights }: { markets: MarketRow[]; insights: InsightView[] }) {
  const reduce = useReducedMotion();
  const { run, pending } = useAction();
  const initial = useMemo(() => Object.fromEntries(markets.map((m) => [m.key, m.allocationPct])), [markets]);
  const [alloc, setAlloc] = useState<Record<string, number>>(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (lastInitial !== initial) {
    // Server data changed (after save/apply/refresh): re-seed local edits.
    setLastInitial(initial);
    setAlloc(initial);
  }
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const enabled = markets.filter((m) => m.enabled);
  const total = round1(enabled.reduce((s, m) => s + (alloc[m.key] ?? 0), 0));
  const changed = markets.filter((m) => round1(alloc[m.key] ?? 0) !== round1(m.allocationPct));
  const balanced = Math.abs(total - 100) < 0.05;

  const balance = () => {
    const sum = enabled.reduce((s, m) => s + (alloc[m.key] ?? 0), 0);
    if (sum <= 0) {
      const even = round1(100 / Math.max(1, enabled.length));
      setAlloc((a) => ({ ...a, ...Object.fromEntries(enabled.map((m) => [m.key, even])) }));
      return;
    }
    const next = { ...alloc };
    let acc = 0;
    enabled.forEach((m, i) => {
      const v = i === enabled.length - 1 ? round1(100 - acc) : round1(((alloc[m.key] ?? 0) / sum) * 100);
      next[m.key] = v;
      acc += v;
    });
    setAlloc(next);
  };

  const latest = insights[0];

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="markets-title">
        <div className="hairline-b mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 pb-2">
          <h2 id="markets-title" className="text-[13px] font-semibold text-fg">
            Sourcing allocation
          </h2>
          <span className="text-xs text-fg-3">share of Scout effort per service family · enabled markets total 100%</span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-fg-3">
            <span className="h-2.5 w-[2px] rounded-full bg-info" aria-hidden /> recommended
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3 [&>th]:h-8 [&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:font-medium [&>th]:shadow-[inset_0_-1px_0_0_var(--gp-line-strong)]">
                <th className="w-12 text-left">On</th>
                <th className="text-left">Market</th>
                <th className="w-[250px] text-left">Allocation</th>
                <th className="text-right">Opps/day</th>
                <th className="text-right">Avg budget</th>
                <th className="text-right">Margin</th>
                <th className="text-right" title="Higher = more competing proposals">Competition</th>
                <th className="text-right" title="Historical win rate (neutral scale — marketplace win rates are naturally low)">Win rate</th>
                <th className="text-right" title="Fulfilment reliability">Reliability</th>
                <th className="text-left">Demand</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const v = alloc[m.key] ?? 0;
                const dirty = round1(v) !== round1(m.allocationPct);
                const rec = m.recommendedAllocationPct;
                return (
                  <tr key={m.key} className={cn("[&>td]:px-3 [&>td]:py-2.5 [&>td]:shadow-[inset_0_-1px_0_0_var(--gp-line)]", !m.enabled && "[&>td]:opacity-55")} data-testid="market-row" data-market-key={m.key}>
                    <td className="align-middle !opacity-100">
                      <Switch
                        checked={m.enabled}
                        disabled={pending && busyKey === m.key}
                        onCheckedChange={(on) => {
                          setBusyKey(m.key);
                          run(() => setMarketEnabledAction(m.key, on), { onSuccess: () => setBusyKey(null), onError: () => setBusyKey(null) });
                        }}
                        label={`${m.enabled ? "Pause" : "Enable"} ${m.name}`}
                        testId={`market-toggle-${m.key}`}
                      />
                    </td>
                    <td className="max-w-[230px]">
                      <p className="truncate font-medium text-fg">{m.name}</p>
                      <p className="truncate text-xs text-fg-3" title={m.description}>
                        {m.description}
                      </p>
                    </td>
                    <td>
                      <div className="flex items-center gap-3">
                        <Slider value={v} onValueChange={(nv) => setAlloc((a) => ({ ...a, [m.key]: nv }))} min={0} max={60} step={1} disabled={!m.enabled} label={`${m.name} allocation`} marker={rec} className="w-28" />
                        <Input
                          type="number"
                          inputSize="sm"
                          min={0}
                          max={100}
                          value={String(round1(v))}
                          onChange={(e) => setAlloc((a) => ({ ...a, [m.key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                          disabled={!m.enabled}
                          aria-label={`${m.name} allocation percent`}
                          className={cn("w-12 text-right font-mono text-xs tabular", dirty && "ring-fg-2")}
                        />
                        <span className="-ml-2 font-mono text-[11px] text-fg-3">%</span>
                        {rec !== null && round1(rec) !== round1(v) ? (
                          <Tooltip content={`Market Research recommends ${rec}%`}>
                            <button type="button" className="whitespace-nowrap font-mono text-[11px] text-info hover:underline" onClick={() => setAlloc((a) => ({ ...a, [m.key]: rec }))} disabled={!m.enabled}>
                              → {rec}%
                            </button>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                    <td className="text-right font-mono text-xs tabular text-fg">{m.metrics.opportunitiesPerDay.toFixed(1)}</td>
                    <td className="text-right font-mono text-xs tabular text-fg">{formatUsd(m.metrics.avgBudgetUsd)}</td>
                    <td className="text-right">
                      <Ratio v={m.metrics.avgMargin || null} />
                    </td>
                    <td className="text-right">
                      <Ratio v={m.metrics.competition} invert />
                    </td>
                    <td className="text-right">
                      <Ratio v={m.metrics.winRate} neutral />
                    </td>
                    <td className="text-right">
                      <Ratio v={m.metrics.fulfilmentReliability} />
                    </td>
                    <td>
                      <Trend t={m.metrics.demandTrend} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-fg-3">
          Metrics come from the Market Research Agent’s latest scan where available, otherwise from the last 7 days of observed opportunities. Competition shades red as it rises.
        </p>

        <AnimatePresence>
          {changed.length > 0 || !balanced ? (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-md bg-surface-2 px-4 py-2.5 shadow-3 ring-1 ring-inset ring-line-strong"
              role="region"
              aria-label="Unsaved allocation"
            >
              <span className={cn("font-mono text-[13px] tabular", balanced ? "text-profit" : "text-warn")}>Total {total}%</span>
              <span className="text-xs text-fg-3">{balanced ? `${changed.length} market${changed.length === 1 ? "" : "s"} changed` : `Enabled markets must total 100% (${total > 100 ? "over" : "under"} by ${round1(Math.abs(100 - total))} pts)`}</span>
              <div className="ml-auto flex items-center gap-2">
                {!balanced ? (
                  <Button size="sm" variant="outline" onClick={balance}>
                    <Scale className="size-3.5" /> Balance to 100%
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setAlloc(initial)} disabled={pending}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!balanced || changed.length === 0}
                  loading={pending && busyKey === "save"}
                  onClick={() => {
                    setBusyKey("save");
                    run(() => saveAllocationsAction(changed.map((m) => ({ key: m.key, allocationPct: alloc[m.key] ?? 0 }))), { onSuccess: () => setBusyKey(null), onError: () => setBusyKey(null) });
                  }}
                  data-testid="markets-save"
                >
                  Save allocation
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>

      <section aria-labelledby="insights-title" className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="hairline-b mb-3 flex items-center gap-3 pb-2">
            <h2 id="insights-title" className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Sparkles className="size-3.5 text-fg-3" strokeWidth={1.75} />
              Market Research Agent
            </h2>
            {latest ? (
              <span className="text-xs text-fg-3">
                latest scan <RelTime date={latest.createdAt} /> · {latest.provider}/{latest.model}
              </span>
            ) : null}
          </div>
          {latest ? (
            <InsightCard insight={latest} markets={markets} primary />
          ) : (
            <Callout tone="neutral" icon={<Sparkles />} title="No research yet">
              The Market Research Agent scans demand, pricing and competition weekly. Its first recommendations appear here — nothing changes until you apply them.
            </Callout>
          )}
        </div>
        <div className="min-w-0">
          <p className="eyebrow hairline-b mb-3 pb-2">Earlier insights</p>
          {insights.length > 1 ? (
            <ul className="flex flex-col divide-y divide-line">
              {insights.slice(1).map((i) => (
                <li key={i.id} className="py-2.5">
                  <p className="text-[13px] text-fg">{i.headline}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-fg-3">{i.summary}</p>
                  <p className="mt-1 font-mono text-[10.5px] text-fg-3">
                    <RelTime date={i.createdAt} /> · {i.body.recommendations.length} recommendation{i.body.recommendations.length === 1 ? "" : "s"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-3">History of scans shows here.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function InsightCard({ insight, markets, primary }: { insight: InsightView; markets: MarketRow[]; primary?: boolean }) {
  const { run, pending } = useAction();
  const name = (k: string) => markets.find((m) => m.key === k)?.name ?? k;
  const current = (k: string) => markets.find((m) => m.key === k)?.allocationPct ?? null;
  const allApplied = insight.body.recommendations.every((r) => r.toPct === undefined || current(r.marketKey) === r.toPct);
  return (
    <div className="rounded-md bg-surface-1 ring-1 ring-inset ring-line">
      <div className="px-4 pt-4">
        <p className="font-display text-[17px] font-semibold tracking-[-0.015em] text-fg">{insight.headline}</p>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-6 text-fg-2">{insight.summary}</p>
        {insight.body.signals.length ? (
          <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-line sm:grid-cols-4">
            {insight.body.signals.slice(0, 4).map((s) => (
              <div key={s.label} className="bg-surface-1 px-3 py-2">
                <dt className="truncate text-[11px] text-fg-3">{s.label}</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold text-fg">
                  {s.value}
                  {s.trend ? <Trend t={s.trend} /> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <ul className="mt-4 divide-y divide-line border-t border-line">
        {insight.body.recommendations.map((r, i) => (
          <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[180px_130px_minmax(0,1fr)]">
            <span className="truncate text-[13px] font-medium text-fg">{name(r.marketKey)}</span>
            <span className="font-mono text-xs tabular text-fg-2 sm:order-none">
              <span className={cn("mr-1.5 uppercase", r.action === "increase" || r.action === "enable" ? "text-profit" : r.action === "decrease" || r.action === "disable" ? "text-warn" : "text-fg-3")}>{r.action}</span>
              {r.fromPct !== undefined && r.toPct !== undefined ? (
                <>
                  {r.fromPct}% <ArrowRight className="inline size-3" /> {r.toPct}%
                </>
              ) : null}
            </span>
            <span className="col-span-2 text-xs leading-5 text-fg-3 sm:col-span-1">{r.reason}</span>
          </li>
        ))}
      </ul>
      {primary ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <Button variant={allApplied ? "secondary" : "primary"} loading={pending} disabled={allApplied} onClick={() => run(() => applyRecommendationAction(insight.id))} data-testid="market-apply-recommendation">
            <Sparkles className="size-3.5" strokeWidth={1.75} />
            {allApplied ? "Recommendation applied" : "Apply recommendation"}
          </Button>
          <span className="text-xs text-fg-3">Updates allocation and enabled markets in one audited change. Nothing else is affected.</span>
        </div>
      ) : null}
    </div>
  );
}
