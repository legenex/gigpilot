/**
 * Pilot Core — simulation + Canvas 2D renderer (framework-free).
 *
 * The ring is the operating loop: signals fan in from sources on the intake
 * side, travel clockwise through seven specialist agents, pause at three owner
 * gates, detour through Recovery when QA fails, exit as delivered work, and a
 * learning pulse returns along the lower arc to re-weight sourcing.
 */

export type Vec = { x: number; y: number };

export interface Layout {
  w: number;
  h: number;
  mode: "wide" | "tall";
  cx: number;
  cy: number;
  R: number;
  phi: number;
  sources: Vec[];
  fan: { p0: Vec; c1: Vec; c2: Vec; p3: Vec }[];
  recovery: Vec;
  market: Vec;
  exit: Vec;
  out: Vec;
  ticker: { left: number; top: number; width: number };
}

export const STATION_COUNT = 7;
const PI = Math.PI;
const TAU = PI * 2;

export function computeLayout(w: number, h: number, sourceCount: number): Layout {
  const wide = w >= 880;
  if (wide) {
    const R = Math.min(h * 0.34, w * 0.16);
    const cx = w * 0.455;
    const cy = h * 0.5;
    const phi = PI;
    const sx = Math.max(150, w * 0.135);
    const spread = Math.min(h * 0.4, R * 1.3);
    const sources = Array.from({ length: sourceCount }, (_, i) => ({ x: sx, y: cy - spread + (2 * spread * i) / Math.max(1, sourceCount - 1) }));
    const intake = { x: cx - R, y: cy };
    const fan = sources.map((p0) => ({
      p0,
      c1: { x: p0.x + (intake.x - p0.x) * 0.52, y: p0.y },
      c2: { x: intake.x - (intake.x - p0.x) * 0.26, y: intake.y },
      p3: intake,
    }));
    const exit = { x: cx + R, y: cy };
    const out = { x: Math.min(w * 0.705, cx + R + 150), y: cy };
    return {
      w,
      h,
      mode: "wide",
      cx,
      cy,
      R,
      phi,
      sources,
      fan,
      recovery: polar(cx, cy, R * 0.56, phi + (6.5 * PI) / 8),
      market: polar(cx, cy, R, phi + PI + (3 * PI) / 4),
      exit,
      out,
      ticker: { left: out.x + 22, top: cy, width: Math.max(180, w - out.x - 30) },
    };
  }
  const R = Math.min(w * 0.275, h * 0.16);
  const cx = w * 0.44;
  const cy = 118 + R * 1.18;
  const phi = -PI / 2;
  const sources = Array.from({ length: sourceCount }, (_, i) => ({
    x: w * (0.075 + (0.85 * i) / Math.max(1, sourceCount - 1)),
    y: 26 + Math.abs(i - (sourceCount - 1) / 2) * -3 + 8,
  }));
  const intake = { x: cx, y: cy - R };
  const fan = sources.map((p0) => ({
    p0,
    c1: { x: p0.x, y: p0.y + (intake.y - p0.y) * 0.55 },
    c2: { x: intake.x, y: intake.y - (intake.y - p0.y) * 0.34 },
    p3: intake,
  }));
  const exit = { x: cx, y: cy + R };
  const out = { x: cx, y: cy + R + 46 };
  return {
    w,
    h,
    mode: "tall",
    cx,
    cy,
    R,
    phi,
    sources,
    fan,
    recovery: polar(cx, cy, R * 0.56, phi + (6.5 * PI) / 8),
    market: polar(cx, cy, R, phi + PI + (3 * PI) / 4),
    exit,
    out,
    ticker: { left: 0, top: out.y + 18, width: w },
  };
}

export function polar(cx: number, cy: number, r: number, a: number): Vec {
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

/** Angle of loop position k (0 = intake, 1..7 = stations, 8 = exit, 16 = back at intake). */
export function loopAngle(L: Layout, k: number) {
  return L.phi + (k * PI) / 8;
}

export const GATES = [3.5, 4.5, 7.5];

function bezier(f: Layout["fan"][number], t: number, o: Vec) {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  o.x = a * f.p0.x + b * f.c1.x + c * f.c2.x + d * f.p3.x;
  o.y = a * f.p0.y + b * f.c1.y + c * f.c2.y + d * f.p3.y;
  return o;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* --------------------------------------------------------------- script -- */

type Tone = "grey" | "orange" | "risk" | "warn";
type Step =
  | { k: "arc"; a0: number; a1: number; d: number; tone?: Tone }
  | { k: "hold"; at: number; d: number; tone?: Tone; gate?: number; station?: number }
  | { k: "line"; p0: "qa" | "rec"; p1: "rec" | "exec"; d: number; tone?: Tone }
  | { k: "out"; d: number }
  | { k: "drop"; d: number; tone?: Tone };

interface Particle {
  on: boolean;
  job: boolean;
  steps: Step[];
  i: number;
  t: number;
  tone: Tone;
  jobIdx: number;
  x: number;
  y: number;
  angle: number;
  onRing: boolean;
  alpha: number;
}

interface FanSig {
  on: boolean;
  src: number;
  t: number;
  dur: number;
}

interface Pulse {
  on: boolean;
  t: number;
}

export interface Hover {
  type: "source" | "station" | "core" | "recovery" | "market" | null;
  idx: number;
}

export interface EngineCallbacks {
  onDeliver?: (jobIdx: number) => void;
  onStats?: (s: EngineStats) => void;
}

export interface EngineStats {
  scanned: number;
  shortlisted: number;
  delivered: number;
  repaired: number;
}

export interface Palette {
  bg: string;
  fg: string;
  fg2: string;
  fg3: string;
  fg4: string;
  line: string;
  accent: string;
  profit: string;
  risk: string;
  warn: string;
  mono: string;
}

export class PilotCoreEngine {
  L: Layout;
  private rnd = mulberry32(20260926);
  private fan: FanSig[] = Array.from({ length: 64 }, () => ({ on: false, src: 0, t: 0, dur: 1 }));
  private parts: Particle[] = Array.from({ length: 48 }, () => ({
    on: false,
    job: false,
    steps: [],
    i: 0,
    t: 0,
    tone: "grey" as Tone,
    jobIdx: 0,
    x: 0,
    y: 0,
    angle: 0,
    onRing: true,
    alpha: 1,
  }));
  private pulses: Pulse[] = Array.from({ length: 6 }, () => ({ on: false, t: 0 }));
  private stationGlow = new Float32Array(STATION_COUNT + 1);
  private gateGlow = new Float32Array(3);
  private sourceGlow = new Float32Array(8);
  private fanGlow = 0;
  private marketGlow = 0;
  private recoveryGlow = 0;
  private coreGlow = 0;
  private outGlow = 0;
  private time = 0;
  private spawnIn = 0;
  private nextJobAt = 0.6;
  private forceJob = false;
  private jobCounter = 0;
  private bursts: { src: number; n: number; next: number }[] = [];
  stats: EngineStats = { scanned: 0, shortlisted: 0, delivered: 0, repaired: 0 };

  // Pointer + scroll inputs (written by the host each frame).
  pointer = { x: 0, y: 0, inside: false, nx: 0, ny: 0 };
  scroll = 0;
  hover: Hover = { type: null, idx: -1 };
  private bugAngle = -PI / 2;
  private bugAlpha = 0;
  private chevron = -PI / 2;
  private bezel = 0;
  private tmp: Vec = { x: 0, y: 0 };
  private rate: number;

  constructor(
    layout: Layout,
    private sourceWeights: number[],
    private jobCount: number,
    private cb: EngineCallbacks = {},
    lowPower = false,
  ) {
    this.L = layout;
    this.rate = lowPower ? 3.2 : 5.2;
  }

  setLayout(L: Layout) {
    this.L = L;
  }

  setCallbacks(cb: EngineCallbacks) {
    this.cb = cb;
  }

  resetStats() {
    this.stats = { scanned: 0, shortlisted: 0, delivered: 0, repaired: 0 };
  }

  burst(src: number) {
    this.bursts.push({ src, n: 6, next: 0 });
    this.sourceGlow[src] = 1;
  }

  injectJob() {
    this.forceJob = true;
    this.coreGlow = 1;
    this.burst(Math.floor(this.rnd() * this.L.sources.length));
  }

  /** Advance the simulation (seconds). */
  step(dt: number) {
    this.time += dt;
    const decay = Math.exp(-dt * 3.2);
    for (let i = 0; i < this.stationGlow.length; i++) this.stationGlow[i]! *= decay;
    for (let i = 0; i < 3; i++) this.gateGlow[i]! *= Math.exp(-dt * 2.2);
    for (let i = 0; i < this.sourceGlow.length; i++) this.sourceGlow[i]! *= decay;
    this.fanGlow *= Math.exp(-dt * 1.4);
    this.marketGlow *= Math.exp(-dt * 1.8);
    this.recoveryGlow *= Math.exp(-dt * 1.6);
    this.coreGlow *= Math.exp(-dt * 2.5);
    this.outGlow *= Math.exp(-dt * 2);

    // spawn fan signals
    const hoveredSrc = this.hover.type === "source" ? this.hover.idx : -1;
    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawnIn = (1 / this.rate) * (0.55 + this.rnd() * 0.9);
      this.spawnFan(this.pickSource(hoveredSrc));
    }
    for (const b of this.bursts) {
      b.next -= dt;
      if (b.next <= 0 && b.n > 0) {
        this.spawnFan(b.src);
        b.n--;
        b.next = 0.07;
      }
    }
    if (this.bursts.length && this.bursts.every((b) => b.n === 0)) this.bursts.length = 0;

    // fan travel
    for (const s of this.fan) {
      if (!s.on) continue;
      s.t += dt / s.dur;
      if (s.t >= 1) {
        s.on = false;
        this.intake();
      }
    }

    // ring particles
    for (const p of this.parts) if (p.on) this.advance(p, dt);

    // learning pulses along the return arc
    for (const u of this.pulses) {
      if (!u.on) continue;
      const prev = u.t;
      u.t += dt / 3.4;
      if (prev < 0.75 && u.t >= 0.75) this.marketGlow = 1;
      if (u.t >= 1) {
        u.on = false;
        this.fanGlow = 1;
      }
    }

    // heading bug follows the pointer; chevron points at the lead job
    const L = this.L;
    let lead = -1,
      leadAngle = this.chevron;
    for (const p of this.parts) {
      if (p.on && p.job && p.i > lead) {
        lead = p.i;
        leadAngle = Math.atan2(p.y - L.cy, p.x - L.cx);
      }
    }
    this.chevron = approachAngle(this.chevron, leadAngle, 1 - Math.exp(-dt * 4));
    if (this.pointer.inside) {
      const a = Math.atan2(this.pointer.y - L.cy, this.pointer.x - L.cx);
      this.bugAngle = approachAngle(this.bugAngle, a, 1 - Math.exp(-dt * 9));
      this.bugAlpha += (1 - this.bugAlpha) * (1 - Math.exp(-dt * 6));
    } else {
      this.bugAngle = approachAngle(this.bugAngle, this.chevron, 1 - Math.exp(-dt * 2));
      this.bugAlpha += (0.55 - this.bugAlpha) * (1 - Math.exp(-dt * 3));
    }
    const targetBezel = this.scroll * 0.9 + this.pointer.nx * 0.12;
    this.bezel += (targetBezel - this.bezel) * (1 - Math.exp(-dt * 5));
  }

  /** Fast-forward so the first frame (and the reduced-motion still) is populated, with a profitable job mid-loop. */
  prewarm(seconds: number) {
    const dt = 1 / 30;
    const cb = this.cb;
    this.cb = {};
    for (let t = 0; t < seconds; t += dt) this.step(dt);
    for (let n = 0; n < 600 && !this.parts.some((p) => p.on && p.job && p.i >= 6 && p.i <= 16); n++) this.step(dt);
    this.cb = cb;
  }

  private pickSource(boost: number) {
    const w = this.sourceWeights;
    let total = 0;
    for (let i = 0; i < w.length; i++) total += (w[i] ?? 1) * (i === boost ? 4 : 1);
    let r = this.rnd() * total;
    for (let i = 0; i < w.length; i++) {
      r -= (w[i] ?? 1) * (i === boost ? 4 : 1);
      if (r <= 0) return i;
    }
    return 0;
  }

  private spawnFan(src: number) {
    const s = this.fan.find((f) => !f.on);
    if (!s) return;
    s.on = true;
    s.src = src;
    s.t = 0;
    s.dur = 1.35 + this.rnd() * 0.8;
    this.sourceGlow[src] = Math.max(this.sourceGlow[src] ?? 0, 0.6);
    this.stats.scanned++;
  }

  private intake() {
    const p = this.parts.find((x) => !x.on);
    if (!p) return;
    const activeJobs = this.parts.reduce((n, x) => n + (x.on && x.job ? 1 : 0), 0);
    const isJob = (this.forceJob || this.time >= this.nextJobAt) && activeJobs < 4;
    p.on = true;
    p.i = 0;
    p.t = 0;
    p.alpha = 1;
    p.tone = "grey";
    p.onRing = true;
    p.job = isJob;
    const arc = (a0: number, a1: number, d: number, tone?: Tone): Step => ({ k: "arc", a0, a1, d, tone });
    const hold = (at: number, d: number, extra: Partial<Extract<Step, { k: "hold" }>> = {}): Step => ({ k: "hold", at, d, ...extra });
    if (isJob) {
      this.forceJob = false;
      this.nextJobAt = this.time + 2.4 + this.rnd() * 1.4;
      p.jobIdx = this.jobCounter++ % Math.max(1, this.jobCount);
      this.stats.shortlisted++;
      const fail = this.rnd() < 0.3;
      const s: Step[] = [
        arc(0, 1, 0.36),
        hold(1, 0.12, { station: 1 }),
        arc(1, 2, 0.36),
        hold(2, 0.2, { station: 2 }),
        arc(2, 3, 0.36),
        hold(3, 0.38, { station: 3, tone: "orange" }),
        arc(3, 3.5, 0.22),
        hold(3.5, 0.5, { gate: 0 }),
        arc(3.5, 4, 0.22),
        hold(4, 0.36, { station: 4 }),
        arc(4, 4.5, 0.22),
        hold(4.5, 0.45, { gate: 1 }),
        arc(4.5, 5, 0.22),
        hold(5, 0.3, { station: 5 }),
        arc(5, 6, 0.36),
        hold(6, 0.9, { station: 6 }),
        arc(6, 7, 0.36),
        hold(7, 0.42, { station: 7 }),
      ];
      if (fail) {
        s.push(
          { k: "line", p0: "qa", p1: "rec", d: 0.5, tone: "risk" },
          hold(-1, 0.55, { tone: "warn" }),
          { k: "line", p0: "rec", p1: "exec", d: 0.5, tone: "warn" },
          hold(6, 0.6, { station: 6, tone: "orange" }),
          arc(6, 7, 0.36),
          hold(7, 0.36, { station: 7 }),
        );
      }
      s.push(arc(7, 7.5, 0.22), hold(7.5, 0.5, { gate: 2 }), arc(7.5, 8, 0.22), { k: "out", d: 0.75 });
      p.steps = s;
    } else {
      const r = this.rnd();
      const dropAt = r < 0.55 ? 1 : r < 0.83 ? 2 : 3;
      const s: Step[] = [];
      for (let k = 1; k <= dropAt; k++) s.push(arc(k - 1, k, 0.34 + this.rnd() * 0.08), hold(k, 0.08, { station: k }));
      s.push({ k: "drop", d: 0.7, tone: dropAt === 3 ? "risk" : "grey" });
      p.steps = s;
    }
    this.place(p);
  }

  private advance(p: Particle, dt: number) {
    let step = p.steps[p.i];
    if (!step) {
      p.on = false;
      return;
    }
    p.t += dt / step.d;
    while (p.t >= 1) {
      this.finish(p, step);
      p.i++;
      p.t -= 1;
      step = p.steps[p.i];
      if (!step || !p.on) {
        p.on = false;
        return;
      }
      this.begin(p, step);
    }
    this.place(p);
  }

  private begin(p: Particle, s: Step) {
    if ("tone" in s && s.tone && s.k !== "drop") p.tone = s.tone;
    if (s.k === "hold") {
      if (s.station !== undefined) this.stationGlow[s.station] = 1;
      if (s.gate !== undefined) this.gateGlow[s.gate] = 1;
      if (s.at === -1) {
        this.recoveryGlow = 1;
        this.stats.repaired++;
      }
    }
  }

  private finish(p: Particle, s: Step) {
    if (s.k === "out") {
      p.on = false;
      this.stats.delivered++;
      this.outGlow = 1;
      const u = this.pulses.find((x) => !x.on);
      if (u) {
        u.on = true;
        u.t = 0;
      }
      this.cb.onDeliver?.(p.jobIdx);
    }
    if (s.k === "drop") p.on = false;
  }

  private place(p: Particle) {
    const L = this.L;
    const s = p.steps[p.i];
    if (!s) return;
    const t = Math.min(1, Math.max(0, p.t));
    p.onRing = true;
    p.alpha = 1;
    switch (s.k) {
      case "arc": {
        p.angle = loopAngle(L, s.a0 + (s.a1 - s.a0) * easeInOut(t));
        const v = polar(L.cx, L.cy, L.R, p.angle);
        p.x = v.x;
        p.y = v.y;
        break;
      }
      case "hold": {
        if (s.at === -1) {
          p.x = L.recovery.x;
          p.y = L.recovery.y;
          p.onRing = false;
        } else {
          p.angle = loopAngle(L, s.at);
          const v = polar(L.cx, L.cy, L.R, p.angle);
          p.x = v.x;
          p.y = v.y;
        }
        break;
      }
      case "line": {
        const qa = polar(L.cx, L.cy, L.R, loopAngle(L, 7));
        const ex = polar(L.cx, L.cy, L.R, loopAngle(L, 6));
        const a = s.p0 === "qa" ? qa : L.recovery;
        const b = s.p1 === "rec" ? L.recovery : ex;
        const e = easeInOut(t);
        p.x = a.x + (b.x - a.x) * e;
        p.y = a.y + (b.y - a.y) * e;
        p.onRing = false;
        break;
      }
      case "out": {
        const e = easeInOut(t);
        p.x = L.exit.x + (L.out.x - L.exit.x) * e;
        p.y = L.exit.y + (L.out.y - L.exit.y) * e;
        p.onRing = false;
        break;
      }
      case "drop": {
        const prev = p.steps[p.i - 1];
        const at = prev && prev.k === "hold" ? prev.at : 1;
        const a = loopAngle(L, at);
        const r = L.R - 30 * t;
        p.x = L.cx + Math.cos(a) * r;
        p.y = L.cy + Math.sin(a) * r;
        p.alpha = 1 - t;
        p.onRing = false;
        if (s.tone === "risk" && t < 0.6) p.tone = "risk";
        break;
      }
    }
  }

  /* ------------------------------------------------------------ render -- */

  draw(ctx: CanvasRenderingContext2D, C: Palette, reduced = false) {
    const L = this.L;
    const { w, h, cx, cy, R } = L;
    const px = this.pointer.nx,
      py = this.pointer.ny;
    const hv = this.hover;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // --- background reticle (deepest parallax layer)
    ctx.save();
    ctx.translate(-px * 10, -py * 8);
    ctx.strokeStyle = C.line;
    ctx.globalAlpha = 0.05;
    ctx.lineWidth = 1;
    for (const k of [1.55, 2.15, 2.9]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * k, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.045;
    ctx.beginPath();
    ctx.moveTo(0, cy + 0.5);
    ctx.lineTo(w, cy + 0.5);
    ctx.moveTo(cx + 0.5, 0);
    ctx.lineTo(cx + 0.5, h);
    ctx.stroke();
    ctx.restore();

    // --- fan paths
    for (let i = 0; i < L.fan.length; i++) {
      const f = L.fan[i]!;
      const hot = hv.type === "source" && hv.idx === i;
      ctx.beginPath();
      ctx.moveTo(f.p0.x, f.p0.y);
      ctx.bezierCurveTo(f.c1.x, f.c1.y, f.c2.x, f.c2.y, f.p3.x, f.p3.y);
      ctx.strokeStyle = hot ? C.accent : C.line;
      ctx.globalAlpha = hot ? 0.75 : 0.11 + this.fanGlow * 0.14 + (this.sourceGlow[i] ?? 0) * 0.08;
      ctx.lineWidth = hot ? 1.25 : 1;
      ctx.stroke();
    }

    // --- source nodes (small squares, instrument-like)
    for (let i = 0; i < L.sources.length; i++) {
      const s = L.sources[i]!;
      const hot = hv.type === "source" && hv.idx === i;
      const g = this.sourceGlow[i] ?? 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.bg;
      ctx.strokeStyle = hot ? C.accent : C.fg3;
      ctx.lineWidth = 1.25;
      const sz = 3.5 + g * 1;
      ctx.fillRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
      ctx.strokeRect(s.x - sz + 0.5, s.y - sz + 0.5, sz * 2 - 1, sz * 2 - 1);
      if (g > 0.05 || hot) {
        ctx.globalAlpha = hot ? 1 : g;
        ctx.fillStyle = hot ? C.accent : C.fg2;
        ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
      }
    }

    // --- return arc (LEARN), dashed and flowing clockwise
    const a8 = loopAngle(L, 8),
      a16 = loopAngle(L, 16);
    ctx.save();
    ctx.setLineDash([2, 5]);
    ctx.lineDashOffset = reduced ? 0 : -this.time * 10;
    ctx.strokeStyle = hv.type === "market" ? C.profit : C.fg2;
    ctx.globalAlpha = hv.type === "market" ? 0.8 : 0.34 + this.marketGlow * 0.2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a8, a16);
    ctx.stroke();
    ctx.restore();

    // --- output line
    ctx.globalAlpha = 0.28 + this.outGlow * 0.4;
    ctx.strokeStyle = this.outGlow > 0.05 ? C.profit : C.fg3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.exit.x, L.exit.y);
    ctx.lineTo(L.out.x, L.out.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.strokeStyle = this.outGlow > 0.05 ? C.profit : C.fg3;
    ctx.beginPath();
    ctx.arc(L.out.x, L.out.y, 3.5 + this.outGlow * 2, 0, TAU);
    ctx.fill();
    ctx.stroke();

    // --- pipeline arc (forward half)
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = C.fg3;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, R, loopAngle(L, 0), a8);
    ctx.stroke();
    if (hv.type === "station") {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.arc(cx, cy, R, loopAngle(L, hv.idx + 1 - 0.5), loopAngle(L, hv.idx + 1 + 0.5));
      ctx.stroke();
    }

    // --- compass card (rotates with scroll + pointer)
    const core = { x: cx + px * 3, y: cy + py * 3 };
    const bug = this.bugAngle;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU + this.bezel;
      const major = i % 6 === 0;
      let d = Math.abs(normAngle(a - bug));
      d = Math.max(0, 1 - d / 0.32) * this.bugAlpha;
      const r0 = R * (major ? 0.76 : 0.81);
      const r1 = R * 0.86;
      ctx.globalAlpha = (major ? 0.36 : 0.16) + d * 0.55;
      ctx.strokeStyle = d > 0.3 ? C.fg : C.fg3;
      ctx.lineWidth = major ? 1.25 : 1;
      ctx.beginPath();
      ctx.moveTo(core.x + Math.cos(a) * r0, core.y + Math.sin(a) * r0);
      ctx.lineTo(core.x + Math.cos(a) * r1, core.y + Math.sin(a) * r1);
      ctx.stroke();
    }
    if (L.mode === "wide") {
      ctx.font = `500 9px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.fg3;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + this.bezel - PI / 2;
        ctx.globalAlpha = 0.5;
        ctx.fillText(String(i * 3), core.x + Math.cos(a) * R * 0.67, core.y + Math.sin(a) * R * 0.67);
      }
    }
    if (!reduced) {
      // heading bug
      ctx.globalAlpha = this.bugAlpha;
      ctx.fillStyle = C.accent;
      const b0 = polar(core.x, core.y, R * 0.875, bug);
      const bl = polar(core.x, core.y, R * 0.945, bug - 0.05);
      const br = polar(core.x, core.y, R * 0.945, bug + 0.05);
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.lineTo(br.x, br.y);
      ctx.closePath();
      ctx.fill();
    }

    // --- recovery loop (QA → Recovery → Execution)
    const qa = polar(cx, cy, R, loopAngle(L, 7));
    const ex = polar(cx, cy, R, loopAngle(L, 6));
    const recHot = hv.type === "recovery";
    ctx.globalAlpha = recHot ? 0.8 : 0.16 + this.recoveryGlow * 0.4;
    ctx.strokeStyle = recHot || this.recoveryGlow > 0.1 ? C.warn : C.fg3;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(qa.x, qa.y);
    ctx.lineTo(L.recovery.x, L.recovery.y);
    ctx.lineTo(ex.x, ex.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.strokeStyle = recHot || this.recoveryGlow > 0.1 ? C.warn : C.fg3;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(L.recovery.x, L.recovery.y, 3.5 + this.recoveryGlow * 1.5, 0, TAU);
    ctx.fill();
    ctx.stroke();

    // --- delegation line to lead job
    const lead = this.parts.reduce<Particle | null>((best, p) => (p.on && p.job && (!best || p.i > best.i) ? p : best), null);
    const coreHot = hv.type === "core";
    if (lead || coreHot) {
      ctx.setLineDash([1, 4]);
      ctx.strokeStyle = C.fg2;
      ctx.lineWidth = 1;
      if (coreHot) {
        ctx.globalAlpha = 0.5;
        for (let k = 1; k <= STATION_COUNT; k++) {
          const s = polar(cx, cy, R, loopAngle(L, k));
          ctx.beginPath();
          ctx.moveTo(core.x, core.y);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
        }
      } else if (lead) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(core.x, core.y);
        ctx.lineTo(lead.x, lead.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- core (Orchestrator)
    const cr = R * 0.2;
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    ctx.arc(core.x, core.y, cr, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = coreHot ? C.fg : C.fg3;
    ctx.globalAlpha = coreHot ? 0.9 : 0.55 + this.coreGlow * 0.4;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(core.x, core.y, cr * 0.62, 0, TAU);
    ctx.stroke();
    // chevron (course arrow), like the mark
    ctx.save();
    ctx.translate(core.x, core.y);
    ctx.rotate(this.chevron + PI / 4);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2;
    const cl = cr * 0.55;
    ctx.beginPath();
    ctx.moveTo(-cl * 0.7, cl * 0.7);
    ctx.lineTo(cl * 0.7, -cl * 0.7);
    ctx.moveTo(cl * 0.7 - cl * 0.62, -cl * 0.7);
    ctx.lineTo(cl * 0.7, -cl * 0.7);
    ctx.lineTo(cl * 0.7, -cl * 0.7 + cl * 0.62);
    ctx.stroke();
    ctx.restore();

    // --- fan particles
    const v = this.tmp;
    for (const s of this.fan) {
      if (!s.on) continue;
      const f = L.fan[s.src];
      if (!f) continue;
      const hot = hv.type === "source" && hv.idx === s.src;
      bezier(f, Math.max(0, s.t - 0.05), v);
      const tx = v.x,
        ty = v.y;
      bezier(f, s.t, v);
      ctx.globalAlpha = hot ? 0.95 : 0.55;
      ctx.strokeStyle = hot ? C.accent : C.fg2;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(v.x, v.y);
      ctx.stroke();
      ctx.fillStyle = hot ? C.accent : C.fg;
      ctx.globalAlpha = hot ? 1 : 0.75;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 1.4, 0, TAU);
      ctx.fill();
    }

    // --- learning pulses on the return arc
    for (const u of this.pulses) {
      if (!u.on) continue;
      const a = a8 + (a16 - a8) * u.t;
      ctx.strokeStyle = C.profit;
      ctx.lineWidth = 1.75;
      ctx.globalAlpha = 0.85 * Math.sin(Math.min(1, u.t * 1.2) * PI) + 0.1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.max(a8, a - 0.28), a);
      ctx.stroke();
    }

    // --- stations
    for (let k = 1; k <= STATION_COUNT; k++) {
      const s = polar(cx, cy, R, loopAngle(L, k));
      const g = this.stationGlow[k] ?? 0;
      const hot = hv.type === "station" && hv.idx === k - 1;
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.bg;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hot ? C.accent : g > 0.5 ? C.fg : C.fg2;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = hot ? 1 : 0.6 + g * 0.4;
      ctx.stroke();
      if (g > 0.02 || hot) {
        ctx.globalAlpha = hot ? 1 : g;
        ctx.fillStyle = hot ? C.accent : C.fg;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.75, 0, TAU);
        ctx.fill();
      }
    }

    // --- owner gates (diamonds)
    for (let gi = 0; gi < GATES.length; gi++) {
      const s = polar(cx, cy, R, loopAngle(L, GATES[gi]!));
      const g = this.gateGlow[gi] ?? 0;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(PI / 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.bg;
      ctx.fillRect(-3.5, -3.5, 7, 7);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.55 + g * 0.45;
      ctx.strokeRect(-3.5, -3.5, 7, 7);
      if (g > 0.02) {
        ctx.globalAlpha = g;
        ctx.fillStyle = C.accent;
        ctx.fillRect(-2, -2, 4, 4);
      }
      ctx.restore();
    }

    // --- ring particles
    for (const p of this.parts) {
      if (!p.on) continue;
      const col = p.tone === "orange" ? C.accent : p.tone === "risk" ? C.risk : p.tone === "warn" ? C.warn : C.fg;
      const st = p.steps[p.i];
      const moving = st && st.k === "arc";
      if (moving && p.onRing) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = p.job ? 0.8 : 0.45;
        ctx.lineWidth = p.job ? 2 : 1.25;
        ctx.beginPath();
        const trail = p.job ? 0.22 : 0.12;
        ctx.arc(cx, cy, R, p.angle - trail, p.angle);
        ctx.stroke();
      }
      ctx.globalAlpha = p.alpha * (p.job ? 1 : 0.8);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.job ? 3 : 1.6, 0, TAU);
      ctx.fill();
      if (p.job && st && st.k === "hold") {
        // working pulse
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.globalAlpha = (1 - p.t) * 0.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + p.t * 9, 0, TAU);
        ctx.stroke();
      }
    }

    // --- market research node on the return arc
    const mHot = hv.type === "market";
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.strokeStyle = mHot || this.marketGlow > 0.1 ? C.profit : C.fg3;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(L.market.x, L.market.y, 4 + this.marketGlow * 1.5, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.globalAlpha = 1;
    this.cb.onStats?.(this.stats);
  }
}

function normAngle(a: number) {
  a = ((a + PI) % TAU + TAU) % TAU;
  return a - PI;
}

function approachAngle(from: number, to: number, k: number) {
  return from + normAngle(to - from) * k;
}
