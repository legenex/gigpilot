"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { BUSINESS_DEFAULTS } from "@gigpilot/config/defaults";
import { cn } from "@gigpilot/ui/lib/cn";
import { formatUsd } from "@gigpilot/ui/lib/format";

const LIM = BUSINESS_DEFAULTS.limits;

/* Script: one job, one QA failure, one repair, one owner approval. Times in seconds. */
type NodeId = "plan" | "scripts" | "stills" | "clips" | "assemble" | "qa" | "recovery" | "deliver";
type Run = { id: NodeId; start: number; end: number; fail?: boolean; note?: string };

const RUNS: Run[] = [
  { id: "plan", start: 0.4, end: 1.6 },
  { id: "scripts", start: 1.8, end: 2.9 },
  { id: "stills", start: 1.8, end: 3.4 },
  { id: "clips", start: 1.8, end: 4.2 },
  { id: "assemble", start: 4.4, end: 5.4 },
  { id: "qa", start: 5.6, end: 6.6, fail: true, note: "2/12 failed" },
  { id: "recovery", start: 6.8, end: 7.8, note: "regen 4 clips" },
  { id: "clips", start: 8.0, end: 9.2, note: "attempt 2/3" },
  { id: "assemble", start: 9.4, end: 10.2 },
  { id: "qa", start: 10.4, end: 11.4, note: "12/12 passed" },
  { id: "deliver", start: 13.8, end: 14.4 },
];
const GATE = { start: 11.6, end: 13.6 };
const END = 17;

type Level = "info" | "success" | "warn" | "error";
const EVENTS: { t: number; type: string; detail: string; level: Level; cost?: number }[] = [
  { t: 0.4, type: "job.state", detail: "intake → planning", level: "info" },
  { t: 1.6, type: "workflow.planned", detail: `5 steps · est. $14.20 · cap $${LIM.perJobSpendLimitUsd}`, level: "info" },
  { t: 1.8, type: "step.started", detail: "copy, stills, clips in parallel", level: "info" },
  { t: 2.9, type: "step.succeeded", detail: "copy agent · 30 hooks + scripts", level: "success", cost: 1.62 },
  { t: 3.4, type: "generation.completed", detail: "Higgsfield · 36 stills", level: "success", cost: 0.16 },
  { t: 4.2, type: "generation.completed", detail: "Kie.ai · 24 clips", level: "success", cost: 7.2 },
  { t: 5.4, type: "step.succeeded", detail: "finishing · 12 cuts assembled", level: "success" },
  { t: 6.6, type: "qa.failed", detail: "2 of 12 cuts: product label unreadable", level: "error" },
  { t: 6.8, type: "repair.started", detail: "regenerate 4 clips · same route", level: "warn" },
  { t: 9.2, type: "repair.completed", detail: "Kie.ai · 4 clips · attempt 2/3", level: "success", cost: 1.2 },
  { t: 10.2, type: "step.succeeded", detail: "finishing · 2 cuts re-assembled", level: "success" },
  { t: 11.4, type: "qa.passed", detail: "12/12 · brief criteria met", level: "success" },
  { t: 11.6, type: "delivery.prepared", detail: "awaiting owner approval", level: "warn" },
  { t: 13.6, type: "delivery.approved", detail: "approved by owner", level: "success" },
  { t: 14.4, type: "job.state", detail: "awaiting_final_approval → delivered", level: "info" },
];

type Status = { s: "queued" | "running" | "pass" | "fail"; p: number; note?: string; attempt: number };

function statusAt(id: NodeId, t: number): Status {
  let last: Run | undefined;
  let attempt = 0;
  for (const r of RUNS) {
    if (r.id === id && r.start <= t) {
      last = r;
      attempt++;
    }
  }
  if (!last) return { s: "queued", p: 0, attempt: 0 };
  if (t < last.end) return { s: "running", p: (t - last.start) / (last.end - last.start), note: last.note, attempt };
  return { s: last.fail ? "fail" : "pass", p: 1, note: last.note, attempt };
}

type Box = { x: number; y: number; w: number; title: string; sub: string };
type LayoutDef = { vb: [number, number]; nodes: Record<NodeId, Box>; gate: { x: number; y: number }; edges: { from: NodeId | "gate"; to: NodeId | "gate"; d: string; kind?: "repair-in" | "repair-out" }[] };

const H = 56;

// Coordinates are drawn close to 1:1 with CSS pixels (WIDE only from `xl`, TALL is capped at 360px),
// so the 12-unit labels render at ≥ 11px everywhere.
const WIDE: LayoutDef = {
  vb: [870, 372],
  nodes: {
    plan: { x: 0, y: 141, w: 128, title: "Plan", sub: "planner agent" },
    scripts: { x: 172, y: 30, w: 128, title: "Hooks + scripts", sub: "copy agent" },
    stills: { x: 172, y: 141, w: 128, title: "Stills ×36", sub: "creative agent" },
    clips: { x: 172, y: 252, w: 128, title: "UGC clips ×24", sub: "creative agent" },
    assemble: { x: 344, y: 141, w: 128, title: "Assemble cuts", sub: "finishing" },
    qa: { x: 516, y: 141, w: 128, title: "QA review", sub: "qa evaluator" },
    recovery: { x: 430, y: 300, w: 128, title: "Recovery", sub: "repair agent" },
    deliver: { x: 730, y: 141, w: 128, title: "Deliver", sub: "client agent" },
  },
  gate: { x: 687, y: 169 },
  edges: [
    { from: "plan", to: "scripts", d: "M128 169 C150 169 150 58 172 58" },
    { from: "plan", to: "stills", d: "M128 169 L172 169" },
    { from: "plan", to: "clips", d: "M128 169 C150 169 150 280 172 280" },
    { from: "scripts", to: "assemble", d: "M300 58 C322 58 322 169 344 169" },
    { from: "stills", to: "assemble", d: "M300 169 L344 169" },
    { from: "clips", to: "assemble", d: "M300 280 C322 280 322 169 344 169" },
    { from: "assemble", to: "qa", d: "M472 169 L516 169" },
    { from: "qa", to: "recovery", d: "M580 197 C580 262 580 328 558 328", kind: "repair-in" },
    { from: "recovery", to: "clips", d: "M430 328 C330 328 236 346 236 308", kind: "repair-out" },
    { from: "qa", to: "gate", d: "M644 169 L680 169" },
    { from: "gate", to: "deliver", d: "M694 169 L730 169" },
  ],
};

const TALL: LayoutDef = {
  vb: [340, 530],
  nodes: {
    plan: { x: 106, y: 0, w: 128, title: "Plan", sub: "planner" },
    scripts: { x: 0, y: 108, w: 104, title: "Scripts", sub: "copy" },
    stills: { x: 118, y: 108, w: 104, title: "Stills ×36", sub: "creative" },
    clips: { x: 236, y: 108, w: 104, title: "Clips ×24", sub: "creative" },
    assemble: { x: 106, y: 216, w: 128, title: "Assemble", sub: "finishing" },
    qa: { x: 106, y: 324, w: 128, title: "QA review", sub: "qa evaluator" },
    recovery: { x: 250, y: 324, w: 90, title: "Recovery", sub: "repair" },
    deliver: { x: 106, y: 470, w: 128, title: "Deliver", sub: "client agent" },
  },
  gate: { x: 170, y: 438 },
  edges: [
    { from: "plan", to: "scripts", d: "M170 56 C170 82 52 82 52 108" },
    { from: "plan", to: "stills", d: "M170 56 L170 108" },
    { from: "plan", to: "clips", d: "M170 56 C170 82 288 82 288 108" },
    { from: "scripts", to: "assemble", d: "M52 164 C52 190 170 190 170 216" },
    { from: "stills", to: "assemble", d: "M170 164 L170 216" },
    { from: "clips", to: "assemble", d: "M288 164 C288 190 170 190 170 216" },
    { from: "assemble", to: "qa", d: "M170 272 L170 324" },
    { from: "qa", to: "recovery", d: "M234 352 L250 352", kind: "repair-in" },
    { from: "recovery", to: "clips", d: "M295 324 C295 260 288 210 288 164", kind: "repair-out" },
    { from: "qa", to: "gate", d: "M170 380 L170 431" },
    { from: "gate", to: "deliver", d: "M170 445 L170 470" },
  ],
};

export function WorkflowDag() {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [reduced, setReduced] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => {
        setReduced(true);
        setT(END - 0.5);
      });
      return () => cancelAnimationFrame(id);
    }
    let timer = 0;
    let visible = false;
    let last = performance.now();
    const run = () => {
      window.clearInterval(timer);
      last = performance.now();
      timer = window.setInterval(() => {
        if (document.hidden) return;
        const now = performance.now();
        const dt = Math.min(0.25, (now - last) / 1000);
        last = now;
        setT((v) => (v + dt >= END ? 0 : v + dt));
      }, 80);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        const was = visible;
        visible = Boolean(e?.isIntersecting);
        if (visible && !was) run();
        if (!visible) window.clearInterval(timer);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  const shownCount = EVENTS.filter((e) => e.t <= t).length;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shownCount]);

  const spend = EVENTS.reduce((a, e) => a + (e.t <= t && e.cost ? e.cost : 0), 0);
  const repairs = t >= 6.8 ? 1 : 0;
  const gate = t >= GATE.start && t < GATE.end ? "waiting" : t >= GATE.end ? "approved" : "idle";
  const shown = EVENTS.filter((e) => e.t <= t);

  return (
    <div ref={ref} className="product-frame overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <span className="text-[14px] font-semibold text-fg">Job · UGC ad set, 12 variants</span>
          <span className="ml-2.5 font-mono text-[11px] text-fg-muted">op_7f3a</span>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-fg-muted sm:ml-auto">
          <div className="flex gap-1.5">
            <dt>Spend</dt>
            <dd className="tnum text-fg">
              {formatUsd(spend, { cents: true })} <span className="text-fg-muted">/ ${LIM.perJobSpendLimitUsd} cap</span>
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Repairs</dt>
            <dd className="tnum text-fg">
              {repairs} <span className="text-fg-muted">/ {LIM.maxRepairsPerJob}</span>
            </dd>
          </div>
          <div className="hidden gap-1.5 md:flex">
            <dt>Attempts</dt>
            <dd className="text-fg">
              ≤ {LIM.maxStepAttempts} <span className="text-fg-muted">/ step</span>
            </dd>
          </div>
        </dl>
        {!reduced && (
          <button
            type="button"
            onClick={() => setT(0)}
            className="focus-ring inline-flex items-center gap-1.5 rounded-xs px-1.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted hover:text-fg"
          >
            <RotateCcw className="size-3" strokeWidth={2} aria-hidden /> Replay
          </button>
        )}
      </div>

      <div className="grid md:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative px-4 py-6 sm:px-6 sm:py-8">
          <Dag def={WIDE} t={t} gate={gate} className="hidden xl:block" />
          <Dag def={TALL} t={t} gate={gate} className="mx-auto block max-w-[360px] xl:hidden" />
          <p className="sr-only">
            The job is planned into five steps. Copy, stills and clips run in parallel, then cuts are assembled. QA fails two of twelve cuts;
            Recovery regenerates four clips on the same route within the attempt limit; QA then passes all twelve and the delivery waits for
            owner approval before it ships.
          </p>
        </div>

        <div className="flex flex-col border-t border-line bg-bg/50 md:border-l md:border-t-0">
          <p className="label border-b border-line px-4 py-2.5 sm:px-5">agent_event · simulated stream</p>
          <ol
            ref={logRef}
            className="h-[252px] overflow-hidden scroll-smooth px-4 py-3 font-mono text-[11px] leading-[18px] sm:px-5 md:h-auto md:min-h-0 md:flex-1"
            aria-label="Event log (simulated)"
          >
            {shown.map((e) => (
              <li key={`${e.t}-${e.type}`} className="grid grid-cols-[46px_minmax(0,1fr)] gap-x-2 py-[3px]" style={reduced ? undefined : { animation: "site-ticker-in 320ms var(--gp-ease-out) both" }}>
                <span className="tnum text-fg-muted">{fmtT(e.t)}</span>
                <span className="min-w-0">
                  <span className={cn(e.level === "success" && "text-profit", e.level === "error" && "text-risk", e.level === "warn" && "text-warn", e.level === "info" && "text-fg-2")}>{e.type}</span>
                  {e.cost !== undefined && <span className="float-right text-fg-muted">{formatUsd(e.cost, { cents: true })}</span>}
                  <span className="block truncate text-fg-muted">{e.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function fmtT(t: number) {
  return `00:${t.toFixed(1).padStart(4, "0")}`;
}

function Dag({ def, t, gate, className }: { def: LayoutDef; t: number; gate: "idle" | "waiting" | "approved"; className?: string }) {
  const st = (id: NodeId) => statusAt(id, t);
  const qa = st("qa");
  const recovering = t >= 6.6 && t < 9.2;
  return (
    <svg viewBox={`0 0 ${def.vb[0]} ${def.vb[1]}`} className={cn("h-auto w-full overflow-visible", className)} aria-hidden>
      <defs>
        <marker id="gp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 7 4 1 7" fill="none" stroke="context-stroke" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      {def.edges.map((e) => {
        const repair = e.kind !== undefined;
        const src = e.from === "gate" ? (gate === "approved" ? "pass" : "queued") : st(e.from).s;
        const dstRunning = e.to !== "gate" && st(e.to).s === "running";
        let stroke = "var(--gp-line-strong)";
        let active = false;
        if (repair) {
          const on = e.kind === "repair-in" ? t >= 6.6 && t < 7.8 : t >= 7.8 && t < 9.2;
          stroke = on ? (e.kind === "repair-in" ? "var(--gp-risk)" : "var(--gp-warn)") : t >= 6.6 ? "var(--gp-fg-4)" : "var(--gp-line)";
          active = on;
        } else if (src === "pass" && dstRunning) {
          stroke = "var(--gp-fg)";
          active = true;
        } else if (src === "pass") {
          stroke = "var(--gp-fg-3)";
        }
        return (
          <path
            key={`${e.from}-${e.to}`}
            d={e.d}
            fill="none"
            stroke={stroke}
            strokeWidth={active ? 1.5 : 1.25}
            strokeDasharray={repair || active ? "3 4" : undefined}
            markerEnd={e.to === "gate" ? undefined : "url(#gp-arrow)"}
            style={active ? { animation: "site-dash 0.8s linear infinite" } : undefined}
          />
        );
      })}

      {/* owner gate */}
      <g transform={`translate(${def.gate.x} ${def.gate.y}) rotate(45)`}>
        <rect x={-7} y={-7} width={14} height={14} fill={gate === "approved" ? "var(--gp-accent)" : "var(--gp-bg-raised)"} stroke="var(--gp-accent)" strokeWidth={1.5} />
        {gate === "waiting" && <rect x={-7} y={-7} width={14} height={14} fill="none" stroke="var(--gp-accent)" strokeWidth={1} style={{ animation: "gp-gate 1.4s var(--gp-ease-out) infinite", transformOrigin: "0 0" }} />}
      </g>
      <text
        x={def.gate.x}
        y={def.gate.y + (def === TALL ? 4 : -18)}
        dx={def === TALL ? 18 : 0}
        textAnchor={def === TALL ? "start" : "middle"}
        className="font-mono"
        fontSize={12}
        letterSpacing="0.02em"
        fill={gate === "waiting" ? "var(--gp-accent-hi)" : "var(--site-fg-3)"}
      >
        {gate === "waiting" ? "AWAITING YOU" : gate === "approved" ? "APPROVED" : "OWNER"}
      </text>

      {(Object.keys(def.nodes) as NodeId[]).map((id) => (
        <DagNode key={id} box={def.nodes[id]} status={st(id)} dim={id === "recovery" && t < 6.6} />
      ))}

      {/* failure callout */}
      {qa.s === "fail" && recovering && (
        <text
          x={def.nodes.qa.x + def.nodes.qa.w / 2}
          y={def.nodes.qa.y - 12}
          textAnchor="middle"
          fontSize={12}
          fill="var(--gp-risk)"
          className="font-mono"
        >
          label unreadable · 2 cuts
        </text>
      )}
    </svg>
  );
}

function DagNode({ box, status, dim }: { box: Box; status: Status; dim?: boolean }) {
  const { s, p, note, attempt } = status;
  const stroke = s === "running" ? "var(--gp-fg-2)" : s === "fail" ? "var(--gp-risk)" : s === "pass" ? "var(--gp-line-bright)" : "var(--gp-line-strong)";
  const dot = s === "running" ? "var(--gp-info)" : s === "pass" ? "var(--gp-profit)" : s === "fail" ? "var(--gp-risk)" : "var(--gp-fg-4)";
  const narrow = box.w < 120;
  const pct = `${Math.round(p * 100)}%`;
  const label =
    s === "running"
      ? narrow
        ? pct
        : `${attempt > 1 ? "retry" : "running"} · ${pct}`
      : s === "pass"
        ? `✓ ${!narrow && note ? note : "done"}`
        : s === "fail"
          ? `✕ ${!narrow && note ? note : "failed"}`
          : "queued";
  return (
    // "Not in play yet" reads through a dashed outline, not opacity, so the labels keep full contrast.
    <g transform={`translate(${box.x} ${box.y})`}>
      <rect
        width={box.w}
        height={H}
        rx={6}
        fill={s === "fail" ? "rgba(242,85,90,0.08)" : dim ? "var(--gp-bg-raised)" : "var(--gp-surface-1)"}
        stroke={stroke}
        strokeWidth={1}
        strokeDasharray={dim ? "3 3" : undefined}
      />
      <circle cx={12} cy={16} r={3} fill={dot}>
        {s === "running" && <animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite" />}
      </circle>
      <text x={22} y={19} fontSize={12.5} fontWeight={500} fill="var(--gp-fg)">
        {box.title}
      </text>
      <text x={12} y={34} fontSize={12} fill="var(--site-fg-3)" className="font-mono">
        {box.sub}
      </text>
      <text
        x={12}
        y={48}
        fontSize={12}
        className="font-mono"
        fill={s === "fail" ? "var(--gp-risk)" : s === "pass" ? "var(--gp-profit)" : s === "running" ? "var(--gp-info)" : "var(--site-fg-3)"}
      >
        {label}
      </text>
      {s === "running" && <rect x={0} y={H - 2} width={box.w * Math.min(1, p)} height={2} rx={1} fill="var(--gp-info)" />}
    </g>
  );
}
