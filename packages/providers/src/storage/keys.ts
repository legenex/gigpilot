import { createHash } from "node:crypto";

/**
 * Storage key rules shared by every driver. Keys are POSIX-style relative
 * paths made of safe segments; anything that could escape the storage root
 * (absolute paths, `..`, NUL, backslashes, drive letters) is rejected.
 */

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageKeyError";
  }
}

const SEGMENT = /^[A-Za-z0-9._@=+-]+$/;

export function assertSafeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new StorageKeyError("Storage key must be a non-empty string");
  if (key.length > 1024) throw new StorageKeyError("Storage key too long");
  if (key.includes("\0")) throw new StorageKeyError("Storage key contains NUL");
  if (key.includes("\\")) throw new StorageKeyError("Storage key contains a backslash");
  if (key.startsWith("/")) throw new StorageKeyError("Storage key must be relative");
  if (/^[A-Za-z]:/.test(key)) throw new StorageKeyError("Storage key must not contain a drive letter");
  const segments = key.split("/");
  for (const s of segments) {
    if (s === "" ) throw new StorageKeyError("Storage key contains an empty segment");
    if (s === "." || s === "..") throw new StorageKeyError("Storage key contains a relative segment");
    if (!SEGMENT.test(s)) throw new StorageKeyError(`Storage key segment has unsafe characters: ${JSON.stringify(s.slice(0, 40))}`);
  }
  return key;
}

/** Filesystem- and URL-safe filename (keeps the extension, max 80 chars). */
export function safeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "file").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toLowerCase() : "";
  const safeStem = stem.length > 0 ? stem : "file";
  return ext ? `${safeStem}.${ext}` : safeStem;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const UUIDISH = /^[A-Za-z0-9-]{1,64}$/;

/** Canonical asset key: tenants/<tenantId>/jobs/<jobId>/<sha256-prefix>-<safe-filename>. */
export function buildAssetKey(input: { tenantId: string; jobId?: string | null; filename: string; sha256: string; scope?: string }): string {
  if (!UUIDISH.test(input.tenantId)) throw new StorageKeyError("Invalid tenant id for storage key");
  const scope = input.jobId ? `jobs/${input.jobId}` : (input.scope ?? "misc");
  if (input.jobId && !UUIDISH.test(input.jobId)) throw new StorageKeyError("Invalid job id for storage key");
  const prefix = input.sha256.slice(0, 16).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(prefix)) throw new StorageKeyError("Invalid sha256 for storage key");
  return assertSafeKey(`tenants/${input.tenantId}/${scope}/${prefix}-${safeFilename(input.filename)}`);
}
