import { getSessionContext } from "@gigpilot/auth";
import { and, asset, eq, getDb } from "@gigpilot/db";
import { getStorage } from "@gigpilot/providers/storage";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f-]{36}$/i;
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg|mp4))$/i;
const SAFE_MIME = /^[a-z]+\/[a-z0-9.+-]+$/i;

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 180) || "download";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 180))}`;
}

/**
 * Authenticated, tenant-checked asset download/preview. Generated content is
 * sandboxed: nosniff everywhere, and SVG is served with a CSP that blocks
 * scripts and external loads.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSessionContext(request.headers);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  if (!rateLimit(`asset:${ctx.user.id}`, 600, 60_000).ok) return new Response("Too many requests", { status: 429 });
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });

  const [row] = await getDb()
    .select()
    .from(asset)
    .where(and(eq(asset.id, id), eq(asset.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });

  let bytes: Uint8Array;
  try {
    bytes = await getStorage().get(row.storageKey);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "NoSuchKey") return new Response("File missing from storage", { status: 404 });
    console.error(JSON.stringify({ level: "error", msg: "asset read failed", assetId: row.id, error: err instanceof Error ? err.message : String(err) }));
    return new Response("Storage unavailable", { status: 503 });
  }

  const mime = SAFE_MIME.test(row.mime) ? row.mime.toLowerCase() : "application/octet-stream";
  const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
  const inline = !wantsDownload && INLINE_MIME.test(mime) && row.kind !== "archive";
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", row.filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (mime === "image/svg+xml") headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  else headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");

  return new Response(bytes as unknown as BodyInit, { status: 200, headers });
}
