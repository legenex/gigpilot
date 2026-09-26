"use client";

import { useId, useMemo, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { BUSINESS_DEFAULTS, PLATFORM_FEE_DEFAULTS } from "@gigpilot/config/defaults";
import { calculateEconomics, scoreOpportunity, statedBudget } from "@gigpilot/economics";
import { cn } from "@gigpilot/ui/lib/cn";
import { formatPct, formatUsd } from "@gigpilot/ui/lib/format";

type Market = "upwork" | "freelancer" | "fiverr" | "contra" | "direct";

const MARKETS: { key: Market; label: string }[] = [
  { key: "upwork", label: "Upwork" },
  { key: "freelancer", label: "Freelancer" },
  { key: "fiverr", label: "Fiverr" },
  { key: "contra", label: "Contra" },
  { key: "direct", label: "Direct" },
];

export interface Preset {
  id: string;
  label: string;
  budget: number;
  production: number;
  hours: number;
  market: Market;
}

const E = BUSINESS_DEFAULTS.economics;
const T = BUSINESS_DEFAULTS.thresholds;
const SIGNALS = { fit: 0.8, complexity: 0.4, revisionRisk: 0.3, deadlineRisk: 0.25, confidence: 0.8, highRisks: 0 };

function feeLabel(m: Market) {
  const f = PLATFORM_FEE_DEFAULTS[m]!;
  const parts = [];
  if (f.pct) parts.push(`${Math.round(f.pct * 100)}%`);
  if (f.fixedUsd) parts.push(`+ $${f.fixedUsd.toFixed(2)}`);
  if (f.minUsd) parts.push(`min $${f.minUsd}`);
  return parts.length ? parts.join(" ") : "0%";
}

export function ProfitCalculator({ presets }: { presets: Preset[] }) {
  const first = presets[0]!;
  const [budget, setBudget] = useState(first.budget);
  const [production, setProduction] = useState(first.production);
  const [hours, setHours] = useState(first.hours);
  const [market, setMarket] = useState<Market>(first.market);
  const [preset, setPreset] = useState<string>(first.id);
  const uid = useId();

  const { econ, score } = useMemo(() => {
    const fee = PLATFORM_FEE_DEFAULTS[market]!;
    const econ = calculateEconomics({
      price: { budgetType: "fixed", budgetMinUsd: budget, budgetMaxUsd: budget, hourlyRateUsd: E.defaultHourlyRateUsd },
      lineItems: [
        { category: "creative", label: "Production + inference", provider: "catalog", model: null, unit: "job", unitCostUsd: production, quantity: 1, attempts: 1, priceSource: "catalog" },
      ],
      platformFee: { key: market, pct: fee.pct, fixedUsd: fee.fixedUsd, minUsd: fee.minUsd },
      revision: { expectedRounds: E.expectedRevisionRounds, costFraction: E.revisionCostFraction },
      contingencyPct: E.contingencyPct,
      shadow: { hours, hourlyRateUsd: E.shadowHourlyRateUsd },
    });
    const score = scoreOpportunity(econ, SIGNALS, T, statedBudget(budget, budget));
    return { econ, score };
  }, [budget, production, hours, market]);

  const custom = () => setPreset("custom");
  const apply = (p: Preset) => {
    setPreset(p.id);
    setBudget(p.budget);
    setProduction(p.production);
    setHours(p.hours);
    setMarket(p.market);
  };

  const price = Math.max(1, econ.priceUsd);
  const segments = [
    { k: "Production", v: econ.fulfilmentCostUsd, c: "bg-violet" },
    { k: "Revisions + contingency", v: econ.revisionContingencyUsd + econ.contingencyUsd, c: "bg-warn" },
    { k: "Owner time", v: econ.shadowCostUsd, c: "bg-info" },
    { k: "Marketplace fee", v: econ.platformFeesUsd, c: "bg-fg-3" },
  ];
  const costShare = Math.min(1, econ.totalCostUsd / price);
  const rec = score.recommendation;

  return (
    <div className="product-frame overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <span className="text-[14px] font-semibold text-fg">Economics</span>
          <span className="ml-2.5 font-mono text-[11px] text-fg-muted">calculateEconomics() · deterministic</span>
        </div>
        <div role="group" aria-label="Load an example" className="flex flex-wrap gap-1 sm:ml-auto">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => apply(p)}
              aria-pressed={preset === p.id}
              className={cn(
                "focus-ring rounded-xs px-2 py-1 text-[12px] transition-colors",
                preset === p.id ? "bg-surface-2 text-fg ring-1 ring-inset ring-line-strong" : "text-fg-muted hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-12">
        {/* Inputs: what agents estimate */}
        <div className="border-b border-line p-4 sm:p-6 lg:col-span-5 lg:border-b-0 lg:border-r">
          <p className="label">Inputs · quantities agents estimate</p>
          <div className="mt-5 space-y-6">
            <Slider
              id={`${uid}-budget`}
              label="Client budget"
              value={budget}
              min={100}
              max={5000}
              step={50}
              display={formatUsd(budget)}
              onChange={(v) => {
                setBudget(v);
                custom();
              }}
            />
            <Slider
              id={`${uid}-prod`}
              label="Production cost"
              hint="generations, inference, tools — priced from the catalog"
              value={production}
              min={0}
              max={1200}
              step={5}
              display={formatUsd(production, { cents: production < 100 })}
              onChange={(v) => {
                setProduction(v);
                custom();
              }}
            />
            <Slider
              id={`${uid}-hours`}
              label="Owner review time"
              hint={`shadow cost at $${E.shadowHourlyRateUsd}/h`}
              value={hours}
              min={0}
              max={12}
              step={0.5}
              display={`${hours.toFixed(1)} h`}
              onChange={(v) => {
                setHours(v);
                custom();
              }}
            />
            <fieldset>
              <legend className="flex w-full items-baseline justify-between text-[13px] text-fg-2">
                Marketplace <span className="tnum font-mono text-[12px] text-fg">{feeLabel(market)}</span>
              </legend>
              <div className="mt-2.5 grid grid-cols-5 gap-px overflow-hidden rounded-sm bg-line ring-1 ring-line">
                {MARKETS.map((m) => (
                  <label
                    key={m.key}
                    className={cn(
                      "relative cursor-pointer py-2 text-center text-[12px] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent",
                      market === m.key ? "bg-surface-3 text-fg" : "bg-bg-raised text-fg-muted hover:text-fg",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${uid}-market`}
                      value={m.key}
                      checked={market === m.key}
                      onChange={() => {
                        setMarket(m.key);
                        custom();
                      }}
                      className="sr-only"
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <p className="mt-6 border-t border-line pt-4 text-[12.5px] leading-[19px] text-fg-muted">
            Held at workspace defaults: {E.expectedRevisionRounds} revision round at {Math.round(E.revisionCostFraction * 100)}% of production,{" "}
            {Math.round(E.contingencyPct * 100)}% contingency.
          </p>
        </div>

        {/* Output: what the calculator decides */}
        <div className="p-4 sm:p-6 lg:col-span-7" aria-live="polite">
          <div className="flex items-center justify-between">
            <p className="label">Output · money the calculator computes</p>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-fg-muted">same inputs → same answer</span>
          </div>

          {/* Price decomposition with the margin gate marked */}
          <div className="mt-5">
            <div className="relative h-8 overflow-hidden rounded-xs bg-profit/15 ring-1 ring-inset ring-line" aria-hidden>
              <div className="absolute inset-y-0 left-0 flex" style={{ width: `${costShare * 100}%`, transition: "width 320ms var(--gp-ease-out)" }}>
                {segments.map((s) => (
                  <span
                    key={s.k}
                    className={cn("h-full border-r border-bg/60", s.c)}
                    style={{ width: econ.totalCostUsd > 0 ? `${(s.v / econ.totalCostUsd) * 100}%` : 0, opacity: 0.85, transition: "width 320ms var(--gp-ease-out)" }}
                  />
                ))}
              </div>
              <span
                className="absolute inset-y-0 bg-profit"
                style={{ left: `${costShare * 100}%`, right: 0, opacity: econ.grossProfitUsd > 0 ? 0.9 : 0, transition: "left 320ms var(--gp-ease-out), opacity 200ms" }}
              />
              <span className="absolute inset-y-[-4px] w-px bg-fg" style={{ left: `${(1 - T.minGrossMargin) * 100}%` }} />
            </div>
            <div className="relative mt-1.5 h-4">
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.07em] text-fg-2"
                style={{ left: `${(1 - T.minGrossMargin) * 100}%` }}
              >
                {formatPct(T.minGrossMargin)} margin gate
              </span>
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {[...segments, { k: "Profit", c: "bg-profit" }].map((s) => (
                <li key={s.k} className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
                  <span className={cn("size-2 rounded-[2px]", s.c)} aria-hidden />
                  {s.k}
                </li>
              ))}
            </ul>
          </div>

          <dl className="mt-6">
            <Line k="Price" v={formatUsd(econ.priceUsd, { cents: true })} strong />
            <Line k="Production + inference" v={`−${formatUsd(econ.fulfilmentCostUsd, { cents: true })}`} />
            <Line k={`Revision contingency · ${E.expectedRevisionRounds} × ${Math.round(E.revisionCostFraction * 100)}%`} v={`−${formatUsd(econ.revisionContingencyUsd, { cents: true })}`} />
            <Line k={`Contingency · ${Math.round(E.contingencyPct * 100)}%`} v={`−${formatUsd(econ.contingencyUsd, { cents: true })}`} />
            <Line k={`Owner time · ${hours.toFixed(1)} h × $${E.shadowHourlyRateUsd}`} v={`−${formatUsd(econ.shadowCostUsd, { cents: true })}`} />
            <Line k={`${MARKETS.find((m) => m.key === market)?.label} fee · ${feeLabel(market)}`} v={`−${formatUsd(econ.platformFeesUsd, { cents: true })}`} />
            <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-line ring-1 ring-line sm:grid-cols-3">
              <Stat k="Expected profit" v={formatUsd(econ.grossProfitUsd, { cents: true })} tone={econ.grossProfitUsd >= T.minExpectedProfitUsd ? "profit" : "risk"} />
              <Stat k="Gross margin" v={formatPct(econ.grossMargin, 1)} tone={econ.grossMargin >= T.minGrossMargin ? "profit" : "risk"} />
              <Stat k="Break-even price" v={formatUsd(econ.breakEvenPriceUsd, { cents: true })} className="col-span-2 sm:col-span-1" />
            </div>
          </dl>

          <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Gates">
              <Gate label={`Margin ≥ ${formatPct(T.minGrossMargin)}`} pass={score.gates.margin.pass} />
              <Gate label={`Profit ≥ ${formatUsd(T.minExpectedProfitUsd)}`} pass={score.gates.profit.pass} />
              <Gate label={`Budget ≥ ${formatUsd(T.preferredMinBudgetUsd)}`} pass={score.gates.budget.pass} soft />
            </ul>
            <div className="flex items-center gap-3">
              <span className="label">Recommendation</span>
              <span
                className={cn(
                  "inline-flex h-8 min-w-[104px] items-center justify-center rounded-sm px-3 font-mono text-[12px] font-medium uppercase tracking-[0.08em] ring-1 ring-inset transition-colors duration-200",
                  rec === "pursue" && "bg-accent text-[#1a0a02] ring-accent",
                  rec === "consider" && "bg-warn-wash text-warn ring-warn/30",
                  rec === "skip" && "bg-surface-2 text-fg-2 ring-line-strong",
                )}
              >
                {rec}
              </span>
            </div>
          </div>
          <p className="mt-3 min-h-[36px] text-[12.5px] leading-[18px] text-fg-muted">{score.reasons.join(". ")}.</p>
        </div>
      </div>
    </div>
  );
}

function Slider({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] text-fg-2">
          {label}
          {hint && <span className="mt-0.5 block text-[11.5px] text-fg-muted">{hint}</span>}
        </label>
        <output htmlFor={id} className="tnum font-mono text-[13px] text-fg">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className="gp-range mt-2"
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
      />
    </div>
  );
}

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed border-line py-[7px]">
      <dt className={cn("text-[13px]", strong ? "text-fg" : "text-fg-muted")}>{k}</dt>
      <dd className={cn("tnum font-mono text-[13px]", strong ? "text-fg" : "text-fg-2")}>{v}</dd>
    </div>
  );
}

function Stat({ k, v, tone, className }: { k: string; v: string; tone?: "profit" | "risk"; className?: string }) {
  return (
    <div className={cn("bg-bg-raised px-3.5 py-3", className)}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.07em] text-fg-muted">{k}</dt>
      <dd className={cn("mt-1 font-display text-[22px] font-semibold tracking-[-0.02em]", tone === "profit" ? "text-profit" : tone === "risk" ? "text-risk" : "text-fg")}>
        {v}
      </dd>
    </div>
  );
}

function Gate({ label, pass, soft }: { label: string; pass: boolean; soft?: boolean }) {
  return (
    <li className="flex items-center gap-1.5 font-mono text-[11.5px] text-fg-2">
      {pass ? (
        <Check className="size-3.5 text-profit" strokeWidth={2.25} aria-label="passes" />
      ) : soft ? (
        <Minus className="size-3.5 text-warn" strokeWidth={2.25} aria-label="soft gate not met" />
      ) : (
        <X className="size-3.5 text-risk" strokeWidth={2.25} aria-label="fails" />
      )}
      {label}
      {soft && <span className="text-fg-muted">soft</span>}
    </li>
  );
}
