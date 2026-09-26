import type { CreativeOutput } from "@gigpilot/contracts";
import { HttpError, safeFetch, type FetchLike, type LookupFn } from "./http";

/**
 * Download provider result URLs immediately into memory (GigPilot storage
 * persists the bytes — provider URLs expire). Provider-supplied URLs are
 * untrusted: every download goes through the SSRF guard with a size cap.
 */

export type CreativeFile = CreativeOutput["files"][number];

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** Sniff common media types from magic bytes. */
export function sniffMime(b: Uint8Array): string | undefined {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "video/webm";
  if ((at(0) === 0x49 && at(1) === 0x44 && at(2) === 0x33) || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return "audio/mpeg";
  return undefined;
}

/** Width/height for PNG, JPEG, GIF and WebP (best effort). */
export function imageDimensions(b: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (mime === "image/png" && b.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (mime === "image/gif" && b.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (mime === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
      if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = dv.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1]!;
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extFromUrl(url: string): string | undefined {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface DownloadOptions {
  prefix: string;
  maxBytes: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  lookup?: LookupFn;
  signal?: AbortSignal;
}

export async function downloadMedia(urls: string[], opts: DownloadOptions): Promise<CreativeFile[]> {
  const files: CreativeFile[] = [];
  let index = 0;
  for (const url of urls) {
    index++;
    const res = await safeFetch(url, {}, { ssrfGuard: true, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs ?? 180_000, retries: 2, fetch: opts.fetch, lookup: opts.lookup, signal: opts.signal });
    if (!res.ok) throw new HttpError("network", `result download failed with HTTP ${res.status}`, { status: res.status });
    if (res.bytes.byteLength === 0) throw new HttpError("network", "result download returned an empty file");
    const headerMime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const mime = sniffMime(res.bytes) ?? (headerMime && headerMime !== "application/octet-stream" ? headerMime : undefined) ?? "application/octet-stream";
    const ext = EXT_BY_MIME[mime] ?? extFromUrl(url) ?? "bin";
    const dims = mime.startsWith("image/") ? imageDimensions(res.bytes, mime) : undefined;
    const safePrefix = opts.prefix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "output";
    files.push({ bytes: res.bytes, mime, filename: `${safePrefix}-${index}.${ext}`, ...(dims ?? {}) });
  }
  return files;
}
