"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { chooseCreativeRoute, CREATIVE_CATALOG, unitsFor } from "@gigpilot/economics";
import { cn } from "@gigpilot/ui/lib/cn";
import { modelName, providerName } from "@/lib/names";

/* ------------------------------------------------------------ router -- */

type Family = "gx" | "factory" | "grok";

// Human names only: task-class ids, model ids and adapter states stay inside the product.
const PROVIDERS: { key: Family; name: string; role: string; price: string }[] = [
  { key: "gx", name: "GX10 cluster", role: "local models · high volume", price: "$0 marginal cost" },
  { key: "factory", name: "Factory Router", role: "reasoning · planning · code", price: "priced per task · sandboxed when enabled" },
  { key: "grok", name: "xAI Grok", role: "live research · when connected", price: "$1.25 / $2.50 per 1M tokens · $0.005 per search" },
];

const TASKS: { task: string; to: Family }[] = [
  { task: "Triage", to: "gx" },
  { task: "Extraction", to: "gx" },
  { task: "Classification", to: "gx" },
  { task: "De-duplication", to: "gx" },
  { task: "Summaries", to: "gx" },
  { task: "Routine QA checks", to: "gx" },
  { task: "Opportunity analysis", to: "factory" },
  { task: "Proposal drafts", to: "factory" },
  { task: "Production planning", to: "factory" },
  { task: "Failure diagnosis", to: "factory" },
  { task: "Code", to: "factory" },
  { task: "High-stakes QA", to: "factory" },
  { task: "Market research", to: "grok" },
  { task: "Live web research", to: "grok" },
];

const ROW = 25;
const TOP = 12;
const PX = { taskX: 160, provX: 284, provW: 232 };
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
      <svg
        viewBox={`0 0 520 ${h}`}
        className="hidden h-auto w-full max-w-[640px] sm:block"
        role="img"
        aria-label="Model router: triage, extraction and routine checks run on local models on the GX10 cluster; reasoning, planning and code can route through Factory Router; live web research goes to xAI Grok when it is connected."
      >
        {TASKS.map((t, i) => {
          const y = TOP + ROW * i + ROW / 2;
          const py = provY[t.to];
          const d = `M${PX.taskX} ${y} C ${PX.taskX + 70} ${y}, ${PX.provX - 70} ${py}, ${PX.provX} ${py}`;
          const on = i === cur;
          return (
            <g key={t.task} onPointerEnter={() => setPinned(i)} onPointerLeave={() => setPinned(null)} className="cursor-default">
              <rect x={0} y={y - ROW / 2} width={PX.taskX + 4} height={ROW} fill="transparent" />
              <text x={PX.taskX - 12} y={y + 4.5} textAnchor="end" fontSize={12.5} fill={on ? "var(--gp-fg)" : "var(--site-fg-3)"}>
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
            <g key={p.key} transform={`translate(${PX.provX} ${y - 28})`}>
              <rect width={PX.provW} height={56} rx={6} fill="var(--gp-surface-1)" stroke={on ? "var(--gp-fg-2)" : "var(--gp-line-strong)"} />
              <circle cx={14} cy={20} r={3} fill={on ? "var(--gp-profit)" : "var(--gp-fg-4)"} />
              <text x={24} y={24.5} fontSize={13.5} fontWeight={600} fill="var(--gp-fg)">
                {p.name}
              </text>
              <text x={14} y={43} fontSize={12.5} fill="var(--site-fg-3)">
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
            <p className="text-[12.5px] text-fg-muted">{p.role}</p>
            <p className="mt-2 text-[13px] leading-[20px] text-fg-2">
              {TASKS.filter((t) => t.to === p.key)
                .map((t) => t.task)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-4 hidden max-w-[640px] items-baseline justify-between gap-4 border-t border-line pt-3 text-[12.5px] sm:flex" aria-live="polite">
        <span>
          <span className="text-fg">{current.task}</span> <span className="text-fg-muted">→</span> <span className="text-fg-2">{prov.name}</span>
        </span>
        <span className="text-right font-mono text-[11.5px] text-fg-muted">{prov.price}</span>
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
  const clearing = routes.some((r) => r.o.qualityPrior >= bar);
  const chosenRoute = routes.find((r) => choice && r.o.model === choice.option.model && r.o.provider === choice.option.provider);
  const rationale = chosenRoute
    ? clearing
      ? `${modelName(chosenRoute.o.model)} via ${providerName(chosenRoute.o.provider)}: the cheapest cost per usable ${capDef.unit} among routes predicted to clear ${bar.toFixed(2)} (predicted ${chosenRoute.o.qualityPrior.toFixed(2)}, ${Math.round(chosenRoute.o.usableRatePrior * 100)}% usable, catalog prior).`
      : `No route is predicted to clear ${bar.toFixed(2)}; ${modelName(chosenRoute.o.model)} via ${providerName(chosenRoute.o.provider)} is the best available.`
    : "";
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
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_64px_72px] gap-x-3 border-y border-line px-4 py-2 font-mono text-[11px] uppercase tracking-[0.05em] text-fg-muted sm:grid-cols-[minmax(0,1fr)_64px_56px_120px] sm:px-5">
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
              )}
            >
              {chosen && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
              <span role="cell" className="min-w-0">
                <span className={cn("block truncate text-[13px] font-medium", clears ? "text-fg" : "text-fg-muted")}>
                  {modelName(r.o.model)} <span className="font-normal text-fg-muted">· {providerName(r.o.provider)}</span>
                </span>
                <span className="block truncate font-mono text-[11px] text-fg-muted">
                  usable {Math.round(r.o.usableRatePrior * 100)}% {chosen ? "· chosen" : !clears ? "· below bar" : ""}
                  {cheapestSticker === r && !chosen ? " · cheapest sticker" : ""}
                </span>
              </span>
              <span role="cell" className={cn("tnum text-right font-mono text-[12px]", clears ? "text-fg-2" : "text-fg-muted")}>
                {r.perReq === null ? "—" : `$${r.perReq < 0.1 ? r.perReq.toFixed(4) : r.perReq.toFixed(2)}`}
              </span>
              <span role="cell" className={cn("tnum hidden text-right font-mono text-[12px] sm:block", clears ? "text-fg" : "text-risk")}>
                {r.o.qualityPrior.toFixed(2)}
              </span>
              <span role="cell" className="flex flex-col items-end gap-1">
                <span className={cn("tnum font-mono text-[12px]", chosen ? "text-accent-hi" : clears ? "text-fg-2" : "text-fg-muted")}>
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
        {rationale}
      </p>
    </div>
  );
}
