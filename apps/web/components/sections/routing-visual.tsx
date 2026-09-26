"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { chooseCreativeRoute, CREATIVE_CATALOG, unitsFor } from "@gigpilot/economics";
import { cn } from "@gigpilot/ui/lib/cn";

/* ------------------------------------------------------------ router -- */

type Family = "gx" | "factory" | "grok";

const PROVIDERS: { key: Family; name: string; role: string; price: string }[] = [
  { key: "gx", name: "GX10 cluster", role: "local · cheap, repetitive work", price: "$0 / 1M tokens" },
  { key: "factory", name: "Factory Router", role: "reasoning · planning · code", price: "routed per task" },
  { key: "grok", name: "xAI Grok", role: "live web research", price: "$1.25 / $2.50 per 1M · $0.005 / search" },
];

const TASKS: { task: string; to: Family }[] = [
  { task: "triage", to: "gx" },
  { task: "extract", to: "gx" },
  { task: "classify", to: "gx" },
  { task: "dedupe", to: "gx" },
  { task: "summarise", to: "gx" },
  { task: "qa_basic", to: "gx" },
  { task: "analyse_opportunity", to: "factory" },
  { task: "proposal", to: "factory" },
  { task: "plan_production", to: "factory" },
  { task: "recovery", to: "factory" },
  { task: "code", to: "factory" },
  { task: "qa_high", to: "factory" },
  { task: "market_research", to: "grok" },
  { task: "web_research", to: "grok" },
];

const ROW = 25;
const TOP = 12;
const PX = { taskX: 150, provX: 296 };
const provY: Record<Family, number> = { gx: TOP + ROW * 2.5, factory: TOP + ROW * 8.5, grok: TOP + ROW * 12.5 };

export function RouterDiagram() {
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => setReduced(true));
      return () => cancelAnimationFrame(id);
    }
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setActive((a) => (a + 5) % TASKS.length);
      setTick((k) => k + 1);
    }, 1100);
    return () => window.clearInterval(id);
  }, []);

  const cur = pinned ?? active;
  const h = TOP * 2 + ROW * TASKS.length;
  const current = TASKS[cur]!;
  const prov = PROVIDERS.find((p) => p.key === current.to)!;

  return (
    <div>
      <svg viewBox={`0 0 520 ${h}`} className="hidden h-auto w-full sm:block" role="img" aria-label="Model router: triage and extraction run on the local GX cluster, reasoning and code go through Factory Router, live web research goes to Grok.">
        {TASKS.map((t, i) => {
          const y = TOP + ROW * i + ROW / 2;
          const py = provY[t.to];
          const d = `M${PX.taskX} ${y} C ${PX.taskX + 90} ${y}, ${PX.provX - 90} ${py}, ${PX.provX} ${py}`;
          const on = i === cur;
          return (
            <g key={t.task} onPointerEnter={() => setPinned(i)} onPointerLeave={() => setPinned(null)} className="cursor-default">
              <rect x={0} y={y - ROW / 2} width={PX.taskX + 4} height={ROW} fill="transparent" />
              <text x={PX.taskX - 12} y={y + 4} textAnchor="end" fontSize={11.5} className="font-mono" fill={on ? "var(--gp-fg)" : "var(--site-fg-3)"}>
                {t.task}
              </text>
              <circle cx={PX.taskX - 2} cy={y} r={2} fill={on ? "var(--gp-fg)" : "var(--gp-fg-4)"} />
              <path d={d} fill="none" stroke={on ? "var(--gp-fg)" : "var(--gp-line-strong)"} strokeWidth={on ? 1.4 : 1} />
              {on && !reduced && (
                <circle key={tick} r={2.6} fill="var(--gp-accent)">
                  <animateMotion dur="0.9s" path={d} fill="freeze" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.16 1 0.3 1" />
                </circle>
              )}
            </g>
          );
        })}
        {PROVIDERS.map((p) => {
          const y = provY[p.key];
          const on = p.key === current.to;
          return (
            <g key={p.key} transform={`translate(${PX.provX} ${y - 26})`}>
              <rect width={220} height={52} rx={6} fill="var(--gp-surface-1)" stroke={on ? "var(--gp-fg-2)" : "var(--gp-line-strong)"} />
              <circle cx={14} cy={18} r={3} fill={on ? "var(--gp-profit)" : "var(--gp-fg-4)"} />
              <text x={24} y={22} fontSize={12.5} fontWeight={600} fill="var(--gp-fg)">
                {p.name}
              </text>
              <text x={14} y={40} fontSize={9.5} className="font-mono" fill="var(--site-fg-3)">
                {p.role}
              </text>
            </g>
          );
        })}
      </svg>

      {/* compact list for small screens */}
      <ul className="grid gap-4 sm:hidden">
        {PROVIDERS.map((p) => (
          <li key={p.key} className="border-t border-line pt-3">
            <p className="text-[14px] font-semibold text-fg">{p.name}</p>
            <p className="font-mono text-[11px] text-fg-muted">{p.role}</p>
            <p className="mt-2 font-mono text-[11.5px] leading-[18px] text-fg-2">
              {TASKS.filter((t) => t.to === p.key)
                .map((t) => t.task)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-4 hidden items-baseline justify-between gap-4 border-t border-line pt-3 font-mono text-[11.5px] sm:flex" aria-live="polite">
        <span>
          <span className="text-fg">{current.task}</span> <span className="text-fg-muted">→</span> <span className="text-fg-2">{prov.name}</span>
        </span>
        <span className="text-fg-muted">{prov.price}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ broker -- */

type Cap = "image.generate" | "video.generate";

const CAPS: { key: Cap; label: string; unit: string; duration?: number }[] = [
  { key: "image.generate", label: "Image · hero still", unit: "image" },
  { key: "video.generate", label: "Video · 8s clip", unit: "clip", duration: 8 },
];

export function CreativeBroker({ defaultThreshold }: { defaultThreshold: number }) {
  const [cap, setCap] = useState<Cap>("video.generate");
  const [bar, setBar] = useState(defaultThreshold);
  const uid = useId();
  const capDef = CAPS.find((c) => c.key === cap)!;

  const routes = useMemo(
    () =>
      CREATIVE_CATALOG.filter((o) => o.capability === cap).map((o) => {
        const perReq = o.unitCostUsd === null ? null : o.unitCostUsd * unitsFor(o, capDef.duration);
        return { o, perReq, perUsable: perReq === null ? null : perReq / Math.max(0.05, o.usableRatePrior) };
      }),
    [cap, capDef.duration],
  );
  const choice = useMemo(
    () => chooseCreativeRoute(cap, { qualityThreshold: bar, preference: ["kie", "higgsfield"], durationSec: capDef.duration }),
    [cap, bar, capDef.duration],
  );
  const maxPer = Math.max(...routes.map((r) => r.perUsable ?? 0));
  const cheapestSticker = routes.reduce<(typeof routes)[number] | null>((m, r) => (r.perReq !== null && (!m || r.perReq < (m.perReq ?? Infinity)) ? r : m), null);

  return (
    <div className="product-frame overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className="text-[14px] font-semibold text-fg">Creative broker</span>
        <div role="radiogroup" aria-label="Asset type" className="flex gap-1 sm:ml-auto">
          {CAPS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={cap === c.key}
              onClick={() => setCap(c.key)}
              className={cn("focus-ring rounded-xs px-2 py-1 text-[12px]", cap === c.key ? "bg-surface-2 text-fg ring-1 ring-inset ring-line-strong" : "text-fg-muted hover:text-fg")}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 sm:px-5">
        <div className="flex items-baseline justify-between">
          <label htmlFor={`${uid}-bar`} className="text-[13px] text-fg-2">
            Quality bar <span className="text-fg-muted">· predicted quality a route must clear</span>
          </label>
          <output htmlFor={`${uid}-bar`} className="tnum font-mono text-[13px] text-fg">
            {bar.toFixed(2)}
          </output>
        </div>
        <input
          id={`${uid}-bar`}
          type="range"
          min={0.6}
          max={0.92}
          step={0.01}
          value={bar}
          onChange={(e) => setBar(Number(e.target.value))}
          className="gp-range mt-2"
          style={{ "--fill": `${((bar - 0.6) / 0.32) * 100}%` } as React.CSSProperties}
        />
      </div>

      <div role="table" aria-label="Candidate routes" className="mt-3">
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_64px_72px] gap-x-3 border-y border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.07em] text-fg-muted sm:grid-cols-[minmax(0,1fr)_64px_56px_120px] sm:px-5">
          <span role="columnheader">Route</span>
          <span role="columnheader" className="text-right">
            $/{capDef.unit}
          </span>
          <span role="columnheader" className="hidden text-right sm:block">
            Quality
          </span>
          <span role="columnheader" className="text-right">
            $/usable
          </span>
        </div>
        {routes.map((r) => {
          const clears = r.o.qualityPrior >= bar;
          const chosen = choice?.option.model === r.o.model && choice.option.provider === r.o.provider;
          return (
            <div
              role="row"
              key={r.o.model}
              className={cn(
                "relative grid grid-cols-[minmax(0,1fr)_64px_72px] items-center gap-x-3 border-b border-line px-4 py-2.5 transition-[background-color,opacity] duration-200 sm:grid-cols-[minmax(0,1fr)_64px_56px_120px] sm:px-5",
                chosen && "bg-accent-wash",
                !clears && "opacity-45",
              )}
            >
              {chosen && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
              <span role="cell" className="min-w-0">
                <span className="block truncate font-mono text-[11.5px] text-fg">
                  {r.o.provider}/{r.o.model}
                </span>
                <span className="block font-mono text-[10px] text-fg-muted">
                  usable {Math.round(r.o.usableRatePrior * 100)}% {chosen ? "· chosen" : !clears ? "· below bar" : ""}
                  {cheapestSticker === r && !chosen ? " · cheapest sticker" : ""}
                </span>
              </span>
              <span role="cell" className="tnum text-right font-mono text-[12px] text-fg-2">
                {r.perReq === null ? "—" : `$${r.perReq < 0.1 ? r.perReq.toFixed(4) : r.perReq.toFixed(2)}`}
              </span>
              <span role="cell" className={cn("tnum hidden text-right font-mono text-[12px] sm:block", clears ? "text-fg" : "text-risk")}>
                {r.o.qualityPrior.toFixed(2)}
              </span>
              <span role="cell" className="flex flex-col items-end gap-1">
                <span className={cn("tnum font-mono text-[12px]", chosen ? "text-accent-hi" : "text-fg-2")}>
                  {r.perUsable === null ? "—" : `$${r.perUsable < 0.1 ? r.perUsable.toFixed(4) : r.perUsable.toFixed(2)}`}
                </span>
                <span className="relative hidden h-[3px] w-full bg-surface-3 sm:block" aria-hidden>
                  <span className={cn("absolute inset-y-0 left-0", chosen ? "bg-accent" : "bg-fg-3")} style={{ width: `${((r.perUsable ?? 0) / maxPer) * 100}%`, transition: "width 320ms var(--gp-ease-out)" }} />
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="px-4 py-3 font-mono text-[11px] leading-[17px] text-fg-muted sm:px-5" aria-live="polite">
        {choice?.rationale}
      </p>
    </div>
  );
}
