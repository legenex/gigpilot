import type { Capability, CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { unitsFor } from "@gigpilot/economics";

/**
 * Deterministic mock creative provider. It renders REAL files — procedural,
 * brand-like SVG ad creatives and, for video capabilities, a storyboard SVG
 * plus a JSON shot list (clearly labelled as a mock storyboard) — so delivery
 * packages contain genuine, inspectable assets. Cost is SIMULATED from the
 * catalog price of the route that would have been used; no money is spent.
 *
 * `simulateDefect` injects a real, checkable defect for QA demos:
 *   - "aspect_ratio"            → wrong canvas dimensions
 *   - "missing_logo_safe_zone"  → logo placed outside the safe zone
 *   - "text_overflow"           → headline wider than the canvas
 */

export type AspectRatio = NonNullable<CreativeRequest["aspectRatio"]>;
export type MockDefect = "aspect_ratio" | "missing_logo_safe_zone" | "text_overflow";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:2": { width: 1620, height: 1080 },
};

const WRONG_ASPECT: Record<AspectRatio, AspectRatio> = {
  "1:1": "16:9",
  "4:5": "16:9",
  "9:16": "1:1",
  "16:9": "9:16",
  "3:2": "9:16",
};

/** Safe-zone inset as a fraction of the shorter side. */
export const SAFE_ZONE_FRACTION = 0.06;
/** Average glyph advance relative to font size (used for text-fit estimates). */
export const GLYPH_ADVANCE = 0.56;

export const MOCK_MODELS: CreativeModelOption[] = (
  [
    ["image.generate", "mock-svg-render", "image"],
    ["image.edit", "mock-svg-edit", "image"],
    ["image.upscale", "mock-svg-upscale", "image"],
    ["video.generate", "mock-storyboard", "clip"],
    ["video.image_to_video", "mock-storyboard", "clip"],
  ] as const
).map(([capability, model, unit]) => ({
  provider: "mock",
  model,
  capability: capability as Capability,
  unitCostUsd: 0,
  unit,
  qualityPrior: 0.7,
  usableRatePrior: 0.95,
  avgLatencySec: 1,
  notes: "Deterministic mock render — simulated cost only",
}));

function fnv(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "creative"
  );
}

export interface CreativeBriefFields {
  headline: string;
  subhead: string;
  cta: string;
  brand: string;
  scene: string;
  script: string[];
}

/** Extracts `Headline: …`, `Subhead: …`, `CTA: …`, `Brand: …`, `Scene: …`, `Script: a | b` fields from a prompt. */
export function parseCreativePrompt(prompt: string): CreativeBriefFields {
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im").exec(prompt)?.[1]?.trim().replace(/^["“]|["”]$/g, "");
  const words = prompt.replace(/\s+/g, " ").trim().split(" ");
  const headline = field("headline") ?? words.slice(0, 6).join(" ");
  const script = (field("script") ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    headline: headline.slice(0, 80),
    subhead: (field("subhead") ?? words.slice(6, 16).join(" ")).slice(0, 120),
    cta: (field("cta") ?? "Learn more").slice(0, 24),
    brand: (field("brand") ?? "Brand").slice(0, 32),
    scene: (field("scene") ?? "Product hero").slice(0, 80),
    script,
  };
}

function palette(seed: string) {
  const h = fnv(seed) % 360;
  return {
    hue: h,
    bg1: `hsl(${h} 52% 12%)`,
    bg2: `hsl(${(h + 32) % 360} 58% 24%)`,
    accent: `hsl(${(h + 180) % 360} 88% 60%)`,
    accent2: `hsl(${(h + 150) % 360} 80% 70%)`,
    ink: "#ffffff",
    muted: "rgba(255,255,255,0.72)",
  };
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

interface RenderOptions {
  width: number;
  height: number;
  requestedAspect: AspectRatio;
  fields: CreativeBriefFields;
  seed: string;
  defect: MockDefect | null;
  simulatedRoute: string;
  variant: number;
  capability: Capability;
}

/** Renders a single brand-like ad composition. */
export function renderAdSvg(o: RenderOptions): string {
  const { width: w, height: h, fields } = o;
  const p = palette(`${fields.brand}|${o.seed}`);
  const r = rng(fnv(`${o.seed}|${o.variant}`));
  const short = Math.min(w, h);
  const margin = Math.round(short * SAFE_ZONE_FRACTION);
  const portrait = h > w * 1.1;

  let fontSize = Math.round(short * (portrait ? 0.085 : 0.07));
  let lines = wrap(fields.headline, Math.max(8, Math.floor((w - margin * 2) / (fontSize * GLYPH_ADVANCE))));
  if (o.defect === "text_overflow") {
    fontSize = Math.round(short * 0.16);
    lines = [fields.headline];
  }
  const subSize = Math.round(fontSize * 0.42);
  const subLines = wrap(fields.subhead, Math.max(12, Math.floor((w - margin * 2) / (subSize * GLYPH_ADVANCE)))).slice(0, 3);

  const logoW = Math.round(short * 0.2);
  const logoH = Math.round(short * 0.07);
  const logoX = o.defect === "missing_logo_safe_zone" ? 4 : margin;
  const logoY = o.defect === "missing_logo_safe_zone" ? 4 : margin;
  const initials = fields.brand
    .split(/\s+/)
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 3)
    .toUpperCase();

  const headTop = logoY + logoH + margin * 1.4;
  const heroTop = headTop + lines.length * fontSize * 1.08 + subLines.length * subSize * 1.3 + margin;
  const ctaH = Math.round(short * 0.1);
  const ctaW = Math.round(Math.max(short * 0.42, fields.cta.length * subSize * 0.7 + subSize * 2));
  const ctaY = h - margin - ctaH - Math.round(short * 0.04);
  const heroBottom = ctaY - margin;
  const heroH = Math.max(short * 0.18, heroBottom - heroTop);
  const heroW = w - margin * 2;

  const blobs = Array.from({ length: 4 }, (_, i) => {
    const cx = Math.round(r() * w);
    const cy = Math.round(r() * h);
    const rad = Math.round(short * (0.18 + r() * 0.35));
    return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${i % 2 ? p.accent : p.accent2}" opacity="${(0.08 + r() * 0.12).toFixed(2)}"/>`;
  }).join("");

  const productShape = (() => {
    const cx = margin + heroW / 2;
    const cy = heroTop + heroH / 2;
    const pw = Math.min(heroW * 0.46, heroH * 0.62);
    const ph = pw * 1.25;
    return [
      `<ellipse cx="${cx.toFixed(0)}" cy="${(cy + ph * 0.52).toFixed(0)}" rx="${(pw * 0.62).toFixed(0)}" ry="${(pw * 0.1).toFixed(0)}" fill="#000" opacity="0.28"/>`,
      `<rect x="${(cx - pw / 2).toFixed(0)}" y="${(cy - ph / 2).toFixed(0)}" width="${pw.toFixed(0)}" height="${ph.toFixed(0)}" rx="${(pw * 0.14).toFixed(0)}" fill="url(#prod)"/>`,
      `<rect x="${(cx - pw / 2 + pw * 0.12).toFixed(0)}" y="${(cy - ph / 2 + ph * 0.1).toFixed(0)}" width="${(pw * 0.76).toFixed(0)}" height="${(ph * 0.08).toFixed(0)}" rx="${(pw * 0.04).toFixed(0)}" fill="#fff" opacity="0.85"/>`,
      `<text x="${cx.toFixed(0)}" y="${(cy + ph * 0.05).toFixed(0)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${Math.round(pw * 0.09)}" font-weight="700" fill="#fff">${esc(initials || "GP")}</text>`,
      `<text x="${cx.toFixed(0)}" y="${(heroTop + heroH - subSize * 0.4).toFixed(0)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${Math.round(subSize * 0.8)}" fill="${p.muted}">${esc(fields.scene)}</text>`,
    ].join("");
  })();

  const headline = lines
    .map((line, i) => `<tspan x="${margin}" y="${Math.round(headTop + fontSize * (i + 0.85) * 1.08)}">${esc(line)}</tspan>`)
    .join("");
  const subStart = headTop + lines.length * fontSize * 1.08 + subSize * 0.9;
  const subhead = subLines.map((line, i) => `<tspan x="${margin}" y="${Math.round(subStart + i * subSize * 1.3)}">${esc(line)}</tspan>`).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-generator="gigpilot-mock-creative" data-capability="${o.capability}" data-requested-aspect="${o.requestedAspect}" data-safe-margin="${margin}">`,
    `<title>${esc(fields.brand)} — ${esc(fields.headline)}</title>`,
    `<desc>GigPilot mock render (simulating ${esc(o.simulatedRoute)}). Procedurally generated — no paid generation was used.</desc>`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient>`,
    `<linearGradient id="prod" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.accent}"/><stop offset="1" stop-color="${p.accent2}"/></linearGradient></defs>`,
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    blobs,
    `<g id="logo"><rect id="logo-mark" x="${logoX}" y="${logoY}" width="${logoW}" height="${logoH}" rx="${Math.round(logoH / 2)}" fill="#fff" opacity="0.94"/>`,
    `<text x="${logoX + logoW / 2}" y="${logoY + logoH * 0.66}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${Math.round(logoH * 0.46)}" font-weight="800" fill="${p.bg1}">${esc(fields.brand.slice(0, 18))}</text></g>`,
    `<text id="headline" font-family="Schibsted Grotesk, Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="${p.ink}" letter-spacing="-0.5">${headline}</text>`,
    `<text id="subhead" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${subSize}" fill="${p.muted}">${subhead}</text>`,
    productShape,
    `<g id="cta"><rect x="${margin}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="${p.accent}"/>`,
    `<text x="${margin + ctaW / 2}" y="${ctaY + ctaH * 0.63}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${Math.round(ctaH * 0.36)}" font-weight="700" fill="${p.bg1}">${esc(fields.cta)}</text></g>`,
    `<text x="${w - margin}" y="${h - Math.round(margin / 2)}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="${Math.max(12, Math.round(short * 0.014))}" fill="#fff" opacity="0.45">MOCK RENDER · simulating ${esc(o.simulatedRoute)}</text>`,
    `</svg>`,
  ].join("\n");
}

export interface StoryboardShot {
  index: number;
  startSec: number;
  endSec: number;
  shot: string;
  onScreenText: string;
  voiceover: string;
  camera: string;
}

const SHOT_BEATS = [
  { shot: "Hook — creator to camera, pattern interrupt", camera: "Handheld close-up, quick push-in" },
  { shot: "Problem — relatable frustration moment", camera: "Over-the-shoulder, natural light" },
  { shot: "Product reveal — unboxing / first use", camera: "Top-down macro, snap zoom" },
  { shot: "Demo — key benefit in action", camera: "Medium shot, jump cuts" },
  { shot: "Proof — result, testimonial or stat", camera: "Split screen before/after" },
  { shot: "Offer — price / bundle / urgency", camera: "Static medium, text-led" },
  { shot: "CTA — clear next step", camera: "Close-up, product in hand" },
  { shot: "End card — logo + CTA", camera: "Locked-off, brand colours" },
];

export function buildShotList(fields: CreativeBriefFields, durationSec: number): StoryboardShot[] {
  const count = Math.min(8, Math.max(4, Math.round(durationSec / 2.5)));
  const beats = count >= SHOT_BEATS.length ? SHOT_BEATS : [...SHOT_BEATS.slice(0, count - 1), SHOT_BEATS[SHOT_BEATS.length - 1]!];
  const step = durationSec / count;
  return beats.map((b, i) => {
    const vo = fields.script[i] ?? (i === 0 ? fields.headline : i === count - 1 ? `${fields.cta} — ${fields.brand}` : fields.subhead.split(/[.;]/)[0] ?? fields.subhead);
    return {
      index: i + 1,
      startSec: Math.round(i * step * 10) / 10,
      endSec: Math.round((i + 1) * step * 10) / 10,
      shot: b.shot,
      onScreenText: i === 0 ? fields.headline : i === count - 1 ? fields.cta : (vo ?? "").split(" ").slice(0, 6).join(" "),
      voiceover: vo ?? "",
      camera: b.camera,
    };
  });
}

export function renderStoryboardSvg(o: RenderOptions & { durationSec: number; shots: StoryboardShot[] }): string {
  const frameAspect = o.width / o.height;
  const portrait = frameAspect < 0.9;
  const cols = portrait ? 4 : 3;
  const fw = portrait ? 240 : frameAspect > 1.2 ? 400 : 300;
  const fh = Math.round(fw / frameAspect);
  const gap = 36;
  const captionH = 120;
  const rows = Math.ceil(o.shots.length / cols);
  const W = cols * fw + (cols + 1) * gap;
  const H = 150 + rows * (fh + captionH + gap) + gap;
  const p = palette(`${o.fields.brand}|${o.seed}`);
  const frames = o.shots
    .map((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gap + col * (fw + gap);
      const y = 150 + row * (fh + captionH + gap);
      const r = rng(fnv(`${o.seed}|frame|${i}`));
      const cx = x + fw * (0.3 + r() * 0.4);
      const cy = y + fh * (0.35 + r() * 0.3);
      const caption = wrap(s.shot, portrait ? 30 : 44).slice(0, 2);
      const ost = wrap(s.onScreenText, portrait ? 18 : 30).slice(0, 2);
      return [
        `<g class="frame" data-index="${s.index}">`,
        `<rect x="${x}" y="${y}" width="${fw}" height="${fh}" rx="10" fill="url(#fbg)" stroke="${p.accent}" stroke-opacity="0.35"/>`,
        `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${Math.round(Math.min(fw, fh) * 0.18)}" fill="${p.accent2}" opacity="0.5"/>`,
        `<rect x="${x + fw * 0.35}" y="${y + fh * 0.45}" width="${fw * 0.3}" height="${fh * 0.3}" rx="8" fill="${p.accent}" opacity="0.75"/>`,
        ...ost.map(
          (l, li) =>
            `<text x="${x + fw / 2}" y="${y + 34 + li * 22}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#fff">${esc(l)}</text>`,
        ),
        `<text x="${x + 10}" y="${y + fh - 12}" font-family="JetBrains Mono, monospace" font-size="14" fill="#fff" opacity="0.8">${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s</text>`,
        `<text x="${x}" y="${y + fh + 26}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="16" font-weight="700" fill="#111">${s.index}. ${esc(caption[0] ?? "")}</text>`,
        caption[1] ? `<text x="${x}" y="${y + fh + 46}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="16" fill="#111">${esc(caption[1])}</text>` : "",
        `<text x="${x}" y="${y + fh + 70}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="14" fill="#555">VO: ${esc(s.voiceover.slice(0, portrait ? 34 : 52))}</text>`,
        `<text x="${x}" y="${y + fh + 90}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="13" fill="#777">${esc(s.camera.slice(0, portrait ? 36 : 56))}</text>`,
        `</g>`,
      ].join("");
    })
    .join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-generator="gigpilot-mock-creative" data-kind="storyboard" data-capability="${o.capability}" data-requested-aspect="${o.requestedAspect}" data-frame-width="${o.width}" data-frame-height="${o.height}" data-duration-sec="${o.durationSec}">`,
    `<title>Mock storyboard — ${esc(o.fields.brand)}: ${esc(o.fields.headline)}</title>`,
    `<desc>MOCK STORYBOARD — not a rendered video. Simulates ${esc(o.simulatedRoute)}; real video is produced only when paid generation is enabled.</desc>`,
    `<defs><linearGradient id="fbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="#f6f5f2"/>`,
    `<text x="${gap}" y="58" font-family="Schibsted Grotesk, Inter, Helvetica, Arial, sans-serif" font-size="34" font-weight="800" fill="#111">${esc(o.fields.brand)} — ${esc(o.fields.headline.slice(0, 60))}</text>`,
    `<text x="${gap}" y="98" font-family="JetBrains Mono, monospace" font-size="18" fill="#e8590c">MOCK STORYBOARD · ${o.requestedAspect} · ${o.durationSec}s · ${o.shots.length} shots · simulating ${esc(o.simulatedRoute)}</text>`,
    frames,
    `</svg>`,
  ].join("\n");
}

export interface MockRenderResult {
  files: CreativeOutput["files"];
  defect: MockDefect | null;
}

export class MockCreativeProvider implements CreativeProvider {
  readonly key = "mock";
  readonly paid = false;

  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: "mock",
      detail: "Deterministic mock renders (SVG creatives, storyboards) — simulated cost only",
      checkedAt: new Date().toISOString(),
    };
  }

  models(): CreativeModelOption[] {
    return MOCK_MODELS;
  }

  async generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    const defect = typeof req.params?.simulateDefect === "string" ? (req.params.simulateDefect as string) : null;
    return this.render(req, option, defect);
  }

  /** Render with an explicit simulated defect (used by the broker). */
  async render(req: CreativeRequest, option: CreativeModelOption, simulateDefect: string | null | undefined): Promise<CreativeOutput> {
    const started = Date.now();
    const defect = (["aspect_ratio", "missing_logo_safe_zone", "text_overflow"] as const).find((d) => d === simulateDefect) ?? null;
    const requested: AspectRatio = req.aspectRatio ?? (req.capability.startsWith("video.") ? "9:16" : "1:1");
    const actualAspect = defect === "aspect_ratio" ? WRONG_ASPECT[requested] : requested;
    const dims = ASPECT_DIMENSIONS[actualAspect];
    const fields = parseCreativePrompt(req.prompt);
    const variant = typeof req.params?.variant === "number" ? (req.params.variant as number) : 0;
    const simulatedRoute =
      typeof option.notes === "string" && option.notes.startsWith("simulates ") ? option.notes.slice("simulates ".length) : `${option.provider}/${option.model}`;
    const base: RenderOptions = {
      width: dims.width,
      height: dims.height,
      requestedAspect: requested,
      fields,
      seed: `${req.prompt}|${req.idempotencyKey.split(":").slice(0, 3).join(":")}`,
      defect,
      simulatedRoute,
      variant,
      capability: req.capability,
    };
    const enc = new TextEncoder();
    const name = `${slug(fields.headline, 32)}-${requested.replace(":", "x")}${variant ? `-v${variant}` : ""}`;
    let files: CreativeOutput["files"];
    if (req.capability.startsWith("video.")) {
      const durationSec = req.durationSec ?? 15;
      const shots = buildShotList(fields, durationSec);
      const svg = renderStoryboardSvg({ ...base, durationSec, shots });
      const shotList = {
        label: "MOCK STORYBOARD — not a rendered video. Real footage is generated by Kie/Higgsfield only when paid generation is enabled.",
        simulatedRoute,
        brand: fields.brand,
        headline: fields.headline,
        aspectRatio: requested,
        frame: { width: dims.width, height: dims.height },
        durationSec,
        shots,
      };
      files = [
        { bytes: enc.encode(svg), mime: "image/svg+xml", filename: `storyboard-${name}.svg` },
        { bytes: enc.encode(JSON.stringify(shotList, null, 2)), mime: "application/json", filename: `shotlist-${name}.json` },
      ];
    } else {
      const svg = renderAdSvg(base);
      files = [{ bytes: enc.encode(svg), mime: "image/svg+xml", filename: `${name}.svg`, width: dims.width, height: dims.height }];
    }
    const units = option.unitCostUsd === null ? 0 : unitsFor(option, req.durationSec ?? 8);
    const costUsd = option.unitCostUsd === null ? 0 : Math.round(option.unitCostUsd * units * 10_000) / 10_000;
    return {
      provider: "mock",
      model: MOCK_MODELS.find((m) => m.capability === req.capability)?.model ?? "mock-svg-render",
      status: "succeeded",
      files,
      costUsd,
      costSource: option.unitCostUsd === null ? "unknown" : "catalog",
      latencyMs: Math.max(1, Date.now() - started),
    };
  }
}
