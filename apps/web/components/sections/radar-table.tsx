"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { RecChip } from "@gigpilot/ui/components/rec-chip";
import { cn } from "@gigpilot/ui/lib/cn";
import { formatPct, formatUsd } from "@gigpilot/ui/lib/format";
import type { RadarRow } from "@/lib/demo-data";

const VISIBLE = 7;
const ROW_H = 52;
const COLS =
  "[grid-template-columns:minmax(0,1fr)_64px_76px] sm:[grid-template-columns:minmax(0,1fr)_76px_80px] md:[grid-template-columns:minmax(0,1fr)_92px_72px_80px_64px_86px]";

type Filter = "all" | RadarRow["recommendation"];
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pursue", label: "Pursue" },
  { key: "consider", label: "Consider" },
  { key: "skip", label: "Skip" },
];

type Slot = { row: RadarRow; analysing: boolean; fresh: boolean };

export function RadarTable({ rows, thresholds }: { rows: RadarRow[]; thresholds: { margin: number; profit: number; budget: number } }) {
  const [slots, setSlots] = useState<Slot[]>(() => rows.slice(0, VISIBLE).map((row) => ({ row, analysing: false, fresh: false })));
  const cursor = useRef(VISIBLE);
  const visibleIds = useRef<string[]>([]);
  const [selected, setSelected] = useState<string>(rows[0]?.id ?? "");
  const follow = useRef(true);
  const idle = useRef<number>(0);
  const root = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");

  useEffect(() => {
    visibleIds.current = slots.map((s) => s.row.id);
  }, [slots]);

  // Stream: a newly discovered opportunity enters "analysing", then resolves.
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = false;
    let timer = 0;
    let resolve = 0;
    const tick = () => {
      // The stream only runs on the unfiltered queue; a filter freezes the demo on its matches.
      if (!visible || document.hidden || filterRef.current !== "all") return;
      let next: RadarRow | undefined;
      for (let k = 0; k < rows.length && !next; k++) {
        const candidate = rows[cursor.current % rows.length];
        cursor.current++;
        if (candidate && !visibleIds.current.includes(candidate.id)) next = candidate;
      }
      if (!next) return;
      const entering = next;
      setSlots((prev) => [{ row: entering, analysing: true, fresh: true }, ...prev.slice(0, VISIBLE - 1).map((s) => ({ ...s, fresh: false }))]);
      resolve = window.setTimeout(() => {
        setSlots((prev) => prev.map((s) => (s.row.id === entering.id ? { ...s, analysing: false } : s)));
        if (follow.current) setSelected(entering.id);
      }, 1500);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = Boolean(e?.isIntersecting);
      window.clearInterval(timer);
      if (visible) timer = window.setInterval(tick, 4200);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
      window.clearTimeout(resolve);
    };
  }, [rows]);

  const pick = (id: string) => {
    follow.current = false;
    setSelected(id);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => (follow.current = true), 9000);
  };

  const applyFilter = (f: Filter) => {
    filterRef.current = f;
    setFilter(f);
    follow.current = f === "all";
  };

  const shown: Slot[] =
    filter === "all"
      ? slots
      : rows
          .filter((r) => r.recommendation === filter)
          .slice(0, VISIBLE)
          .map((row) => ({ row, analysing: false, fresh: false }));
  const current = shown.find((s) => s.row.id === selected && !s.analysing)?.row ?? shown.find((s) => !s.analysing)?.row ?? rows[0]!;
  const pursue = slots.filter((s) => !s.analysing && s.row.recommendation === "pursue").length;
  const counts = { all: rows.length, pursue: 0, consider: 0, skip: 0 } as Record<Filter, number>;
  for (const r of rows) counts[r.recommendation]++;

  return (
    <div ref={root} className="product-frame reveal overflow-hidden">
      {/* app chrome */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="text-[14px] font-semibold text-fg">Radar</span>
          <span className="tnum rounded-xs bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-2">27 viable today</span>
        </div>
        <p className="ml-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted md:order-last">
          <span className="inline-block size-1.5 animate-pulse-dot rounded-full bg-profit text-profit" aria-hidden />
          <span className="hidden sm:inline">Sources polled every 30 min ·</span> {pursue} pursue
        </p>
        <div role="group" aria-label="Filter the demo queue by recommendation" className="-mx-1 flex w-full items-center gap-1 md:mx-0 md:w-auto">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => applyFilter(f.key)}
              className={cn(
                "focus-ring inline-flex h-7 items-center gap-1.5 rounded-xs px-2 text-[12px] transition-colors",
                filter === f.key ? "bg-surface-2 text-fg ring-1 ring-inset ring-line-strong" : "text-fg-muted hover:bg-surface-1 hover:text-fg",
              )}
            >
              {f.label}
              <span className="tnum font-mono text-[11px] text-fg-muted">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* table */}
        <div role="table" aria-label="Opportunity Radar (illustrative)" aria-rowcount={shown.length + 1} className="relative min-w-0">
          <div role="rowgroup">
            <div
              role="row"
              className={cn("grid h-9 items-center gap-x-3 border-b border-line px-4 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted sm:px-5", COLS)}
            >
              <span role="columnheader">Opportunity</span>
              <span role="columnheader" className="hidden text-right md:block">
                Budget
              </span>
              <span role="columnheader" className="hidden text-right md:block">
                Cost
              </span>
              <span role="columnheader" className="text-right">
                Profit
              </span>
              <span role="columnheader" className="hidden text-right md:block">
                Margin
              </span>
              <span role="columnheader" className="text-right">
                Signal
              </span>
            </div>
          </div>
          <div role="rowgroup" className="relative overflow-hidden" style={{ height: VISIBLE * ROW_H }}>
            {shown.map((s, i) => (
              <Row key={s.row.id} slot={s} index={i} selected={s.row.id === current.id} onPick={pick} thresholds={thresholds} />
            ))}
          </div>
          {filter !== "all" && (
            <p aria-hidden className="absolute inset-x-0 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted sm:px-5" style={{ top: 36 + shown.length * ROW_H }}>
              {shown.length} of {rows.length} demo opportunities · {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}
            </p>
          )}
        </div>

        {/* detail */}
        <Detail row={current} thresholds={thresholds} />
      </div>
    </div>
  );
}

function Row({
  slot,
  index,
  selected,
  onPick,
  thresholds,
}: {
  slot: Slot;
  index: number;
  selected: boolean;
  onPick: (id: string) => void;
  thresholds: { margin: number; profit: number };
}) {
  const { row: r, analysing, fresh } = slot;
  return (
    <div
      role="row"
      tabIndex={analysing ? -1 : 0}
      aria-selected={selected}
      onPointerEnter={() => !analysing && onPick(r.id)}
      onFocus={() => !analysing && onPick(r.id)}
      className={cn(
        "absolute inset-x-0 grid cursor-default items-center gap-x-3 border-b border-line px-4 outline-none transition-[transform,background-color] duration-500 ease-out focus-visible:bg-surface-2 sm:px-5",
        COLS,
        selected ? "bg-surface-1" : "hover:bg-surface-1/60",
      )}
      style={{
        height: ROW_H,
        transform: `translateY(${index * ROW_H}px)`,
        animation: fresh ? "site-row-in 560ms var(--gp-ease-out) both, site-flash 2s var(--gp-ease-out) both" : undefined,
      }}
    >
      {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      <span role="cell" className="min-w-0">
        <span className="line-clamp-2 text-[13px] font-medium leading-4 text-fg sm:line-clamp-none sm:block sm:truncate sm:leading-5">{r.title}</span>
        <span className="hidden truncate text-[11.5px] text-fg-muted sm:block">
          <span className="text-fg-2">{r.source.label}</span> · {r.family} · {r.posted} ago
        </span>
      </span>
      <span role="cell" className="tnum hidden text-right font-mono text-[12px] text-fg-2 md:block">
        {r.budgetLabel}
      </span>
      <span role="cell" className="tnum hidden text-right font-mono text-[12px] text-fg-2 md:block">
        {analysing ? <Shimmer /> : formatUsd(r.costUsd)}
      </span>
      <span role="cell" className={cn("tnum text-right font-mono text-[12.5px]", r.profitUsd >= thresholds.profit ? "text-profit" : "text-fg-muted")}>
        {analysing ? <Shimmer /> : formatUsd(r.profitUsd)}
      </span>
      <span role="cell" className="hidden md:block">
        {analysing ? (
          <Shimmer />
        ) : (
          <span className="flex flex-col items-end gap-1">
            <span className={cn("tnum font-mono text-[12px]", r.margin >= thresholds.margin ? "text-fg" : "text-fg-muted")}>{formatPct(r.margin)}</span>
            <span className="relative h-[2px] w-12 bg-surface-3">
              <span
                className={cn("absolute inset-y-0 left-0", r.margin >= thresholds.margin ? "bg-profit" : "bg-risk")}
                style={{ width: `${Math.max(0, Math.min(1, r.margin)) * 100}%` }}
              />
              <span className="absolute -top-[2px] h-[6px] w-px bg-fg-3" style={{ left: `${thresholds.margin * 100}%` }} />
            </span>
          </span>
        )}
      </span>
      <span role="cell" className="flex justify-end">
        <RecChip rec={analysing ? null : r.recommendation} pending="analysing" />
      </span>
    </div>
  );
}

function Shimmer() {
  return <span className="skeleton ml-auto block h-3 w-12" aria-label="calculating" />;
}

function GateMark({ pass, soft }: { pass: boolean; soft?: boolean }) {
  if (pass) return <Check aria-label="pass" className="size-3.5 text-profit" strokeWidth={2.25} />;
  if (soft) return <Minus aria-label="soft fail" className="size-3.5 text-warn" strokeWidth={2.25} />;
  return <X aria-label="fail" className="size-3.5 text-risk" strokeWidth={2.25} />;
}

function Detail({ row: r, thresholds }: { row: RadarRow; thresholds: { margin: number; profit: number; budget: number } }) {
  const ledger: [string, number, string?][] = [
    ["Price", r.priceUsd],
    ["Production + inference", -r.fulfilmentUsd],
    ["Contingency + revisions", -r.contingencyUsd],
    ["Owner time (shadow)", -r.shadowUsd],
    [`${r.source.label} fees`, -r.feesUsd],
  ];
  return (
    <aside aria-label="Selected opportunity" className="border-t border-line bg-bg/40 p-4 sm:p-5 xl:border-l xl:border-t-0" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.07em] text-fg-muted">
          {r.source.label} · {r.source.mode}
        </span>
        <RecChip rec={r.recommendation} />
      </div>
      <p className="mt-2 text-[14px] font-semibold leading-5 text-fg">{r.title}</p>
      <ul className="mt-3 space-y-1">
        {r.deliverables.map((d) => (
          <li key={d} className="flex gap-2 text-[12.5px] leading-[18px] text-fg-2">
            <span aria-hidden className="mt-[7px] h-px w-2 shrink-0 bg-fg-3" />
            {d}
          </li>
        ))}
      </ul>

      <dl className="mt-4 border-t border-line pt-3">
        {ledger.map(([k, v]) => (
          <div key={k} className="flex justify-between py-[3px] text-[12.5px]">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="tnum font-mono text-fg-2">{v < 0 ? `−${formatUsd(-v, { cents: -v < 100 })}` : formatUsd(v)}</dd>
          </div>
        ))}
        <div className="mt-1.5 flex justify-between border-t border-line pt-2 text-[13px]">
          <dt className="font-medium text-fg">Expected profit</dt>
          <dd className={cn("tnum font-mono font-medium", r.profitUsd >= thresholds.profit ? "text-profit" : "text-risk")}>{formatUsd(r.profitUsd)}</dd>
        </div>
      </dl>

      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-sm bg-line ring-1 ring-line">
        {[
          { k: "Margin", v: formatPct(r.margin), t: `≥ ${formatPct(thresholds.margin)}`, pass: r.gates.margin },
          { k: "Profit", v: formatUsd(r.profitUsd), t: `≥ ${formatUsd(thresholds.profit)}`, pass: r.gates.profit },
          { k: "Budget", v: r.budgetLabel, t: `≥ ${formatUsd(thresholds.budget)} soft`, pass: r.gates.budget, soft: true },
        ].map((g) => (
          <div key={g.k} className="bg-bg-raised px-2.5 py-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-fg-muted">{g.k}</span>
              <GateMark pass={g.pass} soft={g.soft} />
            </div>
            <p className="tnum mt-1 truncate font-mono text-[12px] text-fg">{g.v}</p>
            <p className="truncate font-mono text-[11px] text-fg-muted">{g.t}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-[17px] text-fg-muted">{r.reasons.join(". ")}.</p>
    </aside>
  );
}
