"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@gigpilot/ui/lib/cn";
import { formatPct, formatUsd } from "@gigpilot/ui/lib/format";
import { computeLayout, loopAngle, PilotCoreEngine, polar, STATION_COUNT, type Hover, type Layout, type Palette } from "./pilot-core-engine";

export interface CoreNode {
  name: string;
  short: string;
  role: string;
}

export interface PilotCoreProps {
  sources: { key: string; label: string; short: string; mode: string; detail: string }[];
  stations: CoreNode[];
  orchestrator: CoreNode;
  recovery: CoreNode;
  market: CoreNode;
  jobs: { id: string; title: string; profitUsd: number; margin: number }[];
}

type NodeRef = { type: NonNullable<Hover["type"]>; idx: number };

const SOURCE_WEIGHTS = [1.6, 1.2, 0.8, 0.8, 1.4, 0.6];

/**
 * Illustrative opening tally. The counters render these on the server, keep
 * them under reduced motion, and add the live simulation on top otherwise —
 * so the instrument never reads "0 / $0".
 */
function baselineTally(jobs: PilotCoreProps["jobs"]) {
  const delivered = 12;
  let profit = 0;
  for (let i = 0; i < delivered; i++) profit += jobs[i % Math.max(1, jobs.length)]?.profitUsd ?? 0;
  return { scanned: 1286, shortlisted: 19, repaired: 4, delivered, profit };
}

function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    bg: v("--gp-bg", "#08090b"),
    fg: v("--gp-fg", "#edeef0"),
    fg2: v("--gp-fg-2", "#a1a6ae"),
    fg3: v("--gp-fg-3", "#676c75"),
    fg4: v("--gp-fg-4", "#454951"),
    line: "#ffffff",
    accent: v("--gp-accent", "#ff6b2c"),
    profit: v("--gp-profit", "#3fd68c"),
    risk: v("--gp-risk", "#f2555a"),
    warn: v("--gp-warn", "#f2b84b"),
    mono: v("--font-jetbrains", "ui-monospace, monospace"),
  };
}

export function PilotCore({ sources, stations, orchestrator, recovery, market, jobs }: PilotCoreProps) {
  const reduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PilotCoreEngine | null>(null);
  const statRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const base = useMemo(() => baselineTally(jobs), [jobs]);
  const profitRef = useRef(base.profit);
  const serialRef = useRef(412);
  const drawRef = useRef<() => void>(() => {});
  const [layout, setLayout] = useState<Layout | null>(null);
  const [active, setActive] = useState<NodeRef | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [ticker, setTicker] = useState(() =>
    jobs.slice(0, 3).map((j, i) => ({ ...j, serial: `JOB-0${409 + (2 - i)}`, fresh: false })),
  );
  const tipId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onDeliver = useCallback(
    (jobIdx: number) => {
      const j = jobs[(jobIdx + 3) % jobs.length];
      if (!j) return;
      profitRef.current += j.profitUsd;
      const el = statRefs.current.profit;
      if (el) el.textContent = formatUsd(profitRef.current);
      serialRef.current += 1;
      const serial = `JOB-0${serialRef.current}`;
      setTicker((prev) => [{ ...j, serial, fresh: true }, ...prev].slice(0, 4));
    },
    [jobs],
  );

  // Layout + canvas sizing (DPR-aware, no layout shift: the stage has a fixed CSS height).
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const lowPower = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 880;
    const ro = new ResizeObserver(() => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const L = computeLayout(w, h, sources.length);
      if (!engineRef.current) {
        engineRef.current = new PilotCoreEngine(L, SOURCE_WEIGHTS, jobs.length, {}, lowPower);
        engineRef.current.prewarm(7);
        engineRef.current.resetStats();
      } else {
        engineRef.current.setLayout(L);
      }
      setLayout(L);
      drawRef.current();
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [sources.length, jobs.length]);

  // Render loop: runs only while on screen and the tab is visible; static frame for reduced motion.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const layer = layerRef.current;
    const engine = engineRef.current;
    if (!canvas || !stage || !layer || !engine || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const palette = readPalette(stage);
    let lastStats = 0;
    engine.setCallbacks({
      onDeliver,
      onStats: (s) => {
        const now = performance.now();
        if (now - lastStats < 200) return;
        lastStats = now;
        const r = statRefs.current;
        if (r.scanned) r.scanned.textContent = (base.scanned + s.scanned).toLocaleString("en-US");
        if (r.shortlisted) r.shortlisted.textContent = String(base.shortlisted + s.shortlisted);
        if (r.delivered) r.delivered.textContent = String(base.delivered + s.delivered);
        if (r.repaired) r.repaired.textContent = String(base.repaired + s.repaired);
      },
    });

    if (reduced) {
      const drawStatic = () => engine.draw(ctx, palette, true);
      drawRef.current = drawStatic;
      drawStatic();
      return () => {
        drawRef.current = () => {};
      };
    }

    let raf = 0;
    let last = performance.now();
    let onScreen = true;
    let pageVisible = document.visibilityState === "visible";
    let stageTop = stage.getBoundingClientRect().top + window.scrollY;
    const smooth = { x: 0, y: 0 };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = engine.pointer;
      const tx = p.inside ? (p.x / layout.w) * 2 - 1 : 0;
      const ty = p.inside ? (p.y / layout.h) * 2 - 1 : 0;
      const k = 1 - Math.exp(-dt * 4);
      smooth.x += (tx - smooth.x) * k;
      smooth.y += (ty - smooth.y) * k;
      p.nx = smooth.x;
      p.ny = smooth.y;
      const sp = Math.min(1, Math.max(0, window.scrollY / Math.max(1, stageTop + layout.h * 0.8)));
      engine.scroll = sp;
      layer.style.transform = `translate3d(${(-smooth.x * 4).toFixed(2)}px, ${(-smooth.y * 3 - sp * 28).toFixed(2)}px, 0)`;
      engine.step(dt);
      engine.draw(ctx, palette);
      schedule();
    };
    const schedule = () => {
      if (!raf && onScreen && pageVisible) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    drawRef.current = () => engine.draw(ctx, palette);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = Boolean(entry?.isIntersecting);
        if (onScreen) schedule();
        else if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      { rootMargin: "80px 0px" },
    );
    io.observe(stage);
    const onVis = () => {
      pageVisible = document.visibilityState === "visible";
      if (pageVisible) schedule();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const onResize = () => {
      stageTop = stage.getBoundingClientRect().top + window.scrollY;
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("resize", onResize, { passive: true });
    schedule();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
      drawRef.current = () => {};
    };
  }, [layout, reduced, onDeliver, base]);

  // Keep the engine's hover in sync (drives path highlighting).
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.hover = active ? { type: active.type, idx: active.idx } : { type: null, idx: -1 };
    if (reduced) drawRef.current();
  }, [active, reduced]);

  const nodes = useMemo(() => (layout ? buildNodes(layout, sources, stations, orchestrator, recovery, market) : []), [layout, sources, stations, orchestrator, recovery, market]);

  const onPointerMove = (e: React.PointerEvent) => {
    const eng = engineRef.current;
    const stage = stageRef.current;
    if (!eng || !stage || e.pointerType === "touch") return;
    const r = stage.getBoundingClientRect();
    eng.pointer.x = e.clientX - r.left;
    eng.pointer.y = e.clientY - r.top;
    eng.pointer.inside = true;
  };
  const onPointerLeave = () => {
    if (engineRef.current) engineRef.current.pointer.inside = false;
    setActive(null);
  };

  const activate = (n: NodeRef) => {
    const e = engineRef.current;
    if (!e) return;
    if (n.type === "source") e.burst(n.idx);
    if (n.type === "core") e.injectJob();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = nodes.length - 1;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = last;
    if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      setFocusIdx(next);
      buttons.current[next]?.focus();
    }
  };

  const activeNode = active ? nodes.find((n) => n.ref.type === active.type && n.ref.idx === active.idx) : undefined;

  return (
    <figure className="relative m-0" aria-labelledby={`${tipId}-cap`}>
      <figcaption id={`${tipId}-cap`} className="sr-only">
        Pilot Core, a live model of GigPilot&apos;s operating loop. Opportunity signals arrive from six permitted sources and enter a ring
        of seven specialist agents — scout, analyst, economics, proposal, planner, execution and QA. Most signals are filtered out early.
        Profitable ones turn orange, pause at three owner-approval gates, detour through Recovery when QA fails, and exit as delivered
        work. A learning pulse returns along the lower arc to re-weight sourcing. Use the arrow keys to inspect each node.
      </figcaption>

      <div
        ref={stageRef}
        className="relative h-[620px] select-none min-[928px]:-mt-7 min-[928px]:h-[500px] lg:h-[520px]"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <div
          ref={layerRef}
          className={cn("absolute inset-0 transition-opacity duration-700 ease-out will-change-transform", layout ? "opacity-100" : "opacity-0")}
        >
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 block" />

          {/* Interactive node overlay (roving tabindex: one tab stop, arrow keys move) */}
          <div role="group" aria-label="Pilot Core nodes" className="absolute inset-0">
            {nodes.map((n, i) => {
              const isActive = active?.type === n.ref.type && active.idx === n.ref.idx;
              return (
                <button
                  key={`${n.ref.type}-${n.ref.idx}`}
                  ref={(el) => {
                    buttons.current[i] = el;
                  }}
                  type="button"
                  tabIndex={i === focusIdx ? 0 : -1}
                  aria-label={n.aria}
                  aria-describedby={isActive ? tipId : undefined}
                  className="group/node absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                  style={{ left: n.x, top: n.y }}
                  onPointerEnter={() => setActive(n.ref)}
                  onFocus={() => {
                    setFocusIdx(i);
                    setActive(n.ref);
                  }}
                  onBlur={() => setActive((a) => (a && a.type === n.ref.type && a.idx === n.ref.idx ? null : a))}
                  onClick={() => {
                    setActive(n.ref);
                    activate(n.ref);
                  }}
                  onKeyDown={(e) => onKeyDown(e, i)}
                >
                  {n.label && (
                    <span
                      aria-hidden
                      className={cn(
                        "pointer-events-auto absolute whitespace-nowrap font-mono text-[11px] uppercase leading-[14px] tracking-[0.07em] transition-colors duration-150",
                        n.ref.type === "station" ? "text-fg-2" : "text-fg-muted",
                        isActive && "text-fg",
                      )}
                      style={n.labelStyle}
                    >
                      {n.label}
                      {n.sub && <span className="block text-[11px] tracking-[0.04em] text-fg-muted"> {n.sub}</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {layout && (
            <span
              aria-hidden
              className="pointer-events-none absolute whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted"
              style={learnLabelStyle(layout)}
            >
              Learn ← outcomes inform sourcing
            </span>
          )}

          {/* Tooltip */}
          {activeNode && layout && (
            <div
              id={tipId}
              role="tooltip"
              className="pointer-events-none absolute z-20 w-[248px] rounded-md bg-surface-2/95 p-3 shadow-3 ring-1 ring-line-strong"
              style={tooltipStyle(activeNode, layout)}
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted">{activeNode.tag}</p>
              <p className="mt-1 text-[13px] font-semibold text-fg">{activeNode.title}</p>
              <p className="mt-1 text-[12px] leading-[17px] text-fg-2">{activeNode.body}</p>
              {activeNode.hint && <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-accent-hi">{activeNode.hint}</p>}
            </div>
          )}

          {/* Output ticker */}
          <div
            className={cn("absolute", layout?.mode === "wide" ? "-translate-y-1/2" : "")}
            style={layout ? { left: layout.ticker.left, top: layout.ticker.top, width: layout.ticker.width } : { right: 0, top: "50%" }}
          >
            <p className="label mb-2.5 flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-profit" aria-hidden />
              Delivered
            </p>
            <ol className="relative" aria-label="Recently delivered jobs (simulated)">
              {ticker.slice(0, layout?.mode === "tall" ? 3 : 4).map((t, i) => (
                <li
                  key={t.serial}
                  // The oldest entry fades by colour, not opacity, so it keeps ≥ 4.5:1 contrast.
                  className="border-t border-line py-2.5"
                  style={t.fresh && !reduced ? { animation: "site-ticker-in 560ms var(--gp-ease-out) both" } : undefined}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={cn("truncate text-[13px] font-medium", i === 3 ? "text-fg-muted" : "text-fg")}>{t.title}</span>
                    <span className="font-mono text-[11px] tracking-[0.04em] text-fg-muted">{t.serial}</span>
                  </div>
                  <p className={cn("tnum mt-0.5 text-[12px]", i === 3 ? "text-fg-muted" : "text-fg-2")}>
                    <span className={i === 3 ? undefined : "text-profit"}>{formatUsd(t.profitUsd)} profit</span>
                    <span className="text-fg-muted"> · </span>
                    {formatPct(t.margin)} margin
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {/* Telemetry: an illustrative tally, advanced by the simulation while it runs */}
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-[auto_repeat(5,minmax(0,1fr))] lg:items-end">
        <p className="label col-span-2 sm:col-span-3 lg:col-span-1 lg:pr-4">
          Simulated run
          <span className="block normal-case tracking-normal text-fg-muted">illustrative · not live data</span>
        </p>
        {(
          [
            ["scanned", "Signals scanned", base.scanned.toLocaleString("en-US")],
            ["shortlisted", "Shortlisted", String(base.shortlisted)],
            ["repaired", "QA repairs", String(base.repaired)],
            ["delivered", "Delivered", String(base.delivered)],
            ["profit", "Profit booked", formatUsd(base.profit)],
          ] as const
        ).map(([k, label, init]) => (
          <div key={k}>
            <span
              ref={(el) => {
                statRefs.current[k] = el;
              }}
              className={cn("block font-display text-[22px] font-semibold tabular-nums tracking-[-0.02em]", k === "profit" ? "text-profit" : "text-fg")}
            >
              {init}
            </span>
            <span className="label">{label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------ overlay -- */

interface OverlayNode {
  ref: NodeRef;
  x: number;
  y: number;
  label?: string;
  sub?: string;
  labelStyle?: CSSProperties;
  aria: string;
  tag: string;
  title: string;
  body: string;
  hint?: string;
  /** unit vector pointing away from the core, used to place the tooltip */
  ux: number;
  uy: number;
  reach: number;
}

function radialLabel(ux: number, uy: number, gap: number): CSSProperties {
  // Position a label relative to a 32px button centred on the node.
  const s: CSSProperties = {};
  const ax = ux > 0.35 ? "left" : ux < -0.35 ? "right" : "center";
  const ay = uy > 0.35 ? "below" : uy < -0.35 ? "above" : "middle";
  const cx = 16 + ux * gap;
  const cy = 16 + uy * gap;
  if (ax === "left") s.left = cx;
  else if (ax === "right") s.right = 32 - cx;
  else {
    s.left = cx;
    s.transform = "translateX(-50%)";
  }
  if (ay === "below") s.top = cy - 2;
  else if (ay === "above") s.bottom = 32 - cy - 2;
  else {
    s.top = cy;
    s.transform = `${s.transform ?? ""} translateY(-50%)`.trim();
  }
  s.textAlign = ax === "right" ? "right" : ax === "left" ? "left" : "center";
  return s;
}

function buildNodes(
  L: Layout,
  sources: PilotCoreProps["sources"],
  stations: CoreNode[],
  orchestrator: CoreNode,
  recovery: CoreNode,
  market: CoreNode,
): OverlayNode[] {
  const nodes: OverlayNode[] = [];
  sources.forEach((s, i) => {
    const p = L.sources[i]!;
    const wide = L.mode === "wide";
    nodes.push({
      ref: { type: "source", idx: i },
      x: p.x,
      y: p.y,
      label: wide ? s.label : s.short,
      sub: wide ? s.mode : undefined,
      // Tall layout: names alternate below/above their node so full names fit at phone width.
      labelStyle: wide
        ? { right: 30, top: 16, transform: "translateY(-50%)", textAlign: "right" }
        : i % 2 === 0
          ? { left: 16, top: 26, transform: "translateX(-50%)" }
          : { left: 16, bottom: 26, transform: "translateX(-50%)" },
      // Starts with the visible label text so the accessible name contains what sighted users read.
      aria: `${s.label} ${s.mode} source`,
      tag: `Source · ${s.mode}`,
      title: s.label,
      body: s.detail,
      hint: "Click to send a burst of signals",
      ux: wide ? 1 : 0,
      uy: wide ? 0 : 1,
      reach: 20,
    });
  });
  stations.forEach((s, i) => {
    const a = loopAngle(L, i + 1);
    const p = polar(L.cx, L.cy, L.R, a);
    const ux = Math.cos(a),
      uy = Math.sin(a);
    nodes.push({
      ref: { type: "station", idx: i },
      x: p.x,
      y: p.y,
      label: s.short,
      labelStyle: radialLabel(ux, uy, 16),
      aria: `Agent ${i + 1} of ${STATION_COUNT}: ${s.name}`,
      tag: `Agent ${String(i + 1).padStart(2, "0")} / ${String(STATION_COUNT).padStart(2, "0")}`,
      title: s.name,
      body: s.role,
      ux,
      uy,
      reach: 38,
    });
  });
  {
    const a = loopAngle(L, 6.5);
    const ux = Math.cos(a),
      uy = Math.sin(a);
    const tall = L.mode === "tall";
    nodes.push({
      ref: { type: "recovery", idx: 0 },
      x: L.recovery.x,
      y: L.recovery.y,
      label: recovery.short,
      labelStyle: tall ? radialLabel(-1, 0, 12) : radialLabel(-ux, -uy, 12),
      aria: `${recovery.name}`,
      tag: "Repair loop · within limits",
      title: recovery.name,
      body: recovery.role,
      ux: -ux,
      uy: -uy,
      reach: 44,
    });
  }
  {
    const a = loopAngle(L, 8 + 6);
    const ux = Math.cos(a),
      uy = Math.sin(a);
    nodes.push({
      ref: { type: "market", idx: 0 },
      x: L.market.x,
      y: L.market.y,
      label: L.mode === "tall" ? "Market" : market.short,
      labelStyle: radialLabel(ux, uy, 16),
      aria: `${market.name}`,
      tag: "Learning · sourcing weights",
      title: market.name,
      body: market.role,
      ux,
      uy,
      reach: 40,
    });
  }
  nodes.push({
    ref: { type: "core", idx: 0 },
    x: L.cx,
    y: L.cy,
    label: orchestrator.short,
    labelStyle:
      L.mode === "tall"
        ? { left: 16, bottom: 16 + L.R * 0.2 + 6, transform: "translateX(-50%)" }
        : { left: 16, top: 16 + L.R * 0.2 + 8, transform: "translateX(-50%)" },
    aria: `${orchestrator.name} — press to run a job through the loop`,
    tag: "Core",
    title: orchestrator.name,
    body: orchestrator.role,
    hint: "Click to run a job through the loop",
    ux: 0,
    uy: 1,
    reach: L.R * 0.2 + 34,
  });
  return nodes;
}

function tooltipStyle(n: OverlayNode, L: Layout): CSSProperties {
  const W = 248,
    H = 118;
  let x = n.x + n.ux * n.reach;
  let y = n.y + n.uy * n.reach;
  // anchor the tooltip on the side facing away from the node
  x -= W * (0.5 - n.ux * 0.5);
  y -= H * (0.5 - n.uy * 0.5);
  x = Math.max(4, Math.min(L.w - W - 4, x));
  y = Math.max(-8, Math.min(L.h - H, y));
  return { left: x, top: y };
}

function learnLabelStyle(L: Layout): CSSProperties {
  const a = loopAngle(L, 12);
  const p = polar(L.cx, L.cy, L.R + 14, a);
  if (L.mode === "wide") return { left: p.x, top: p.y, transform: "translateX(-50%)" };
  return { left: Math.max(4, p.x - 8), top: p.y, transform: "translate(-100%, -50%) rotate(0deg)", display: "none" };
}
