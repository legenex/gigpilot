/**
 * Deterministic media inspection used by the QA agent. Reads real file
 * headers (PNG, JPEG, WebP, GIF) and SVG markup — never trusts metadata
 * reported by the producing provider.
 */

/** Average glyph advance relative to font size (matches the mock renderer's text-fit model). */
export const GLYPH_ADVANCE = 0.56;

export interface ImageInfo {
  format: "png" | "jpeg" | "webp" | "gif" | "svg" | "unknown";
  width: number | null;
  height: number | null;
}

const ASPECTS: Record<string, number> = { "1:1": 1, "4:5": 4 / 5, "9:16": 9 / 16, "16:9": 16 / 9, "3:2": 3 / 2 };

export function aspectValue(ar: string): number | null {
  if (ASPECTS[ar] !== undefined) return ASPECTS[ar]!;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar);
  return m ? Number(m[1]) / Number(m[2]) : null;
}

export function aspectMatches(width: number, height: number, ar: string, tolerance = 0.02): boolean {
  const target = aspectValue(ar);
  if (!target || width <= 0 || height <= 0) return false;
  return Math.abs(width / height - target) / target <= tolerance;
}

export function describeAspect(width: number, height: number): string {
  for (const [k, v] of Object.entries(ASPECTS)) if (Math.abs(width / height - v) / v <= 0.02) return k;
  return `${width}×${height}`;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function svgNumber(attr: string | undefined): number | null {
  if (!attr) return null;
  const n = Number.parseFloat(attr);
  return Number.isFinite(n) ? n : null;
}

export function svgRootAttributes(svg: string): Record<string, string> {
  const m = /<svg\b([^>]*)>/i.exec(svg);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const a of m[1]!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g)) out[a[1]!] = a[2]!;
  return out;
}

export function inspectImage(bytes: Uint8Array, mime?: string): ImageInfo {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: u16be(bytes, o + 5), width: u16be(bytes, o + 7) };
      }
      const len = u16be(bytes, o + 2);
      if (len < 2) break;
      o += 2 + len;
    }
    return { format: "jpeg", width: null, height: null };
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") {
      return { format: "webp", width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
    }
    if (chunk === "VP8 ") return { format: "webp", width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff };
    if (chunk === "VP8L") {
      const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
      return { format: "webp", width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    return { format: "webp", width: null, height: null };
  }
  if (bytes.length >= 10 && String.fromCharCode(...bytes.slice(0, 4)) === "GIF8") {
    return { format: "gif", width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096)));
  if (/<svg\b/i.test(head) || mime === "image/svg+xml") {
    const attrs = svgRootAttributes(new TextDecoder().decode(bytes));
    let width = svgNumber(attrs.width);
    let height = svgNumber(attrs.height);
    if ((width === null || height === null) && attrs.viewBox) {
      const vb = attrs.viewBox.split(/[\s,]+/).map(Number);
      if (vb.length === 4) {
        width = width ?? vb[2]!;
        height = height ?? vb[3]!;
      }
    }
    return { format: "svg", width, height };
  }
  return { format: "unknown", width: null, height: null };
}

export interface SvgLayoutCheck {
  logo: { x: number; y: number; width: number; height: number } | null;
  safeMargin: number | null;
  headline: { fontSize: number; lines: string[] } | null;
}

export function inspectSvgLayout(svg: string): SvgLayoutCheck {
  const attrs = svgRootAttributes(svg);
  const logoTag = /<rect\b[^>]*\bid="logo-mark"[^>]*>/i.exec(svg)?.[0];
  const attr = (tag: string, name: string) => svgNumber(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]);
  const logo =
    logoTag !== undefined
      ? { x: attr(logoTag, "x") ?? 0, y: attr(logoTag, "y") ?? 0, width: attr(logoTag, "width") ?? 0, height: attr(logoTag, "height") ?? 0 }
      : null;
  const head = /<text\b([^>]*\bid="headline"[^>]*)>([\s\S]*?)<\/text>/i.exec(svg);
  let headline: SvgLayoutCheck["headline"] = null;
  if (head) {
    const fontSize = svgNumber(/font-size="([^"]*)"/.exec(head[1]!)?.[1]) ?? 0;
    const lines = [...head[2]!.matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&[a-z]+;/g, "x"));
    headline = { fontSize, lines: lines.length ? lines : [head[2]!.replace(/<[^>]+>/g, "")] };
  }
  return { logo, safeMargin: svgNumber(attrs["data-safe-margin"]), headline };
}

/** Parse an SRT file into cues; returns problems found (overlaps, bad timestamps). */
export function checkSrt(text: string): { cues: number; problems: string[] } {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const problems: string[] = [];
  let prevEnd = -1;
  let cues = 0;
  const toMs = (t: string) => {
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(t.trim());
    if (!m) return null;
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  };
  for (const b of blocks) {
    const lines = b.split("\n");
    if (lines.length < 3) {
      problems.push(`cue ${cues + 1}: incomplete block`);
      continue;
    }
    const [start, end] = (lines[1] ?? "").split("-->");
    const s = start ? toMs(start) : null;
    const e = end ? toMs(end) : null;
    cues++;
    if (s === null || e === null) {
      problems.push(`cue ${cues}: malformed timestamp`);
      continue;
    }
    if (e <= s) problems.push(`cue ${cues}: ends before it starts`);
    if (s < prevEnd) problems.push(`cue ${cues}: overlaps the previous cue`);
    prevEnd = e;
  }
  if (cues === 0) problems.push("no subtitle cues found");
  return { cues, problems };
}
