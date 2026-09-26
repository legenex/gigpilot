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

// ---------------------------------------------------------------------------
// Duplicate detection (QA deliverable uniqueness)
// ---------------------------------------------------------------------------

export interface PerceptualSignature {
  /** "text" = visible text + canvas of a vector render (exact match); "ahash" = 64-bit average hash of a raster (Hamming ≤ 5). */
  kind: "text" | "ahash";
  value: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Cheap perceptual signature of an SVG: the visible text (headline, subhead, CTA, scene,
 * shot captions) plus the canvas size, ignoring decorative randomness (background blobs,
 * gradients), numbers (variant / timecode labels) and the mock watermark. Two renders with
 * the same signature look the same to a client.
 */
export function svgSignature(svg: string): string {
  const attrs = svgRootAttributes(svg);
  const texts = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, " ")))
    .map((t) => t.toLowerCase().replace(/[0-9]+/g, "").replace(/[^a-z\s]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t && !/mock render|mock storyboard|simulating/.test(t));
  const canvas = `${attrs["data-frame-width"] ?? attrs.width ?? "?"}x${attrs["data-frame-height"] ?? attrs.height ?? "?"}`;
  return `${canvas}|${texts.join("|")}`;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * 8×8 average hash of an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA). Returns
 * null for formats it cannot decode cheaply (callers fall back to sha256 only).
 */
export function pngAverageHash(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): string | null {
  try {
    if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    let o = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat: Uint8Array[] = [];
    while (o + 8 <= bytes.length) {
      const len = u32be(bytes, o);
      const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
      const data = bytes.subarray(o + 8, o + 8 + len);
      if (type === "IHDR") {
        width = u32be(data, 0);
        height = u32be(data, 4);
        bitDepth = data[8]!;
        colorType = data[9]!;
        interlace = data[12]!;
      } else if (type === "IDAT") idat.push(data);
      else if (type === "IEND") break;
      o += 12 + len;
    }
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || channels === 0 || width * height > 25_000_000) return null;
    const joined = new Uint8Array(idat.reduce((a, d) => a + d.length, 0));
    let p = 0;
    for (const d of idat) {
      joined.set(d, p);
      p += d.length;
    }
    const raw = inflate(joined);
    const stride = width * channels;
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    const sums = new Float64Array(64);
    const counts = new Float64Array(64);
    for (let y = 0; y < height; y++) {
      const base = y * (stride + 1);
      const filter = raw[base]!;
      for (let x = 0; x < stride; x++) {
        const v = raw[base + 1 + x]!;
        const a = x >= channels ? cur[x - channels]! : 0;
        const b = prev[x]!;
        const c = x >= channels ? prev[x - channels]! : 0;
        cur[x] = (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paethPredictor(a, b, c)) & 0xff;
      }
      const cy = Math.min(7, Math.floor((y * 8) / height));
      for (let x = 0; x < width; x++) {
        const i = x * channels;
        const grey = channels >= 3 ? 0.299 * cur[i]! + 0.587 * cur[i + 1]! + 0.114 * cur[i + 2]! : cur[i]!;
        const cell = cy * 8 + Math.min(7, Math.floor((x * 8) / width));
        sums[cell]! += grey;
        counts[cell]! += 1;
      }
      prev.set(cur);
    }
    const cells = Array.from(sums, (s, i) => s / Math.max(1, counts[i]!));
    const mean = cells.reduce((a, b) => a + b, 0) / 64;
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      let nibble = 0;
      for (let k = 0; k < 4; k++) if (cells[i + k]! > mean) nibble |= 1 << (3 - k);
      hex += nibble.toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

export function perceptualSignature(bytes: Uint8Array, mime: string, inflate: (data: Uint8Array) => Uint8Array): PerceptualSignature | null {
  if (mime === "image/svg+xml") return { kind: "text", value: svgSignature(new TextDecoder().decode(bytes)) };
  if (mime === "image/png") {
    const h = pngAverageHash(bytes, inflate);
    return h ? { kind: "ahash", value: h } : null;
  }
  return null;
}

/** Same-looking deliverables: identical text signature, or raster hashes within Hamming 5. */
export function sameLook(a: PerceptualSignature, b: PerceptualSignature): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "text" ? a.value === b.value : hammingHex(a.value, b.value) <= 5;
}
