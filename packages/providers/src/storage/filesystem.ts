import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderHealth } from "@gigpilot/contracts";
import type { StorageAdapter, StoredObject } from "../types";
import { assertSafeKey, sha256Hex, StorageKeyError } from "./keys";

/**
 * Local filesystem driver rooted at STORAGE_ROOT. Writes are atomic
 * (temp file + rename) and every key is resolved and verified to stay under
 * the root (defence in depth on top of key validation).
 */
export class FilesystemStorage implements StorageAdapter {
  readonly driver = "filesystem" as const;
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a validated key to an absolute path that is guaranteed to be inside the root. */
  resolveKey(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !full.startsWith(this.root + path.sep)) {
      throw new StorageKeyError("Storage key escapes the storage root");
    }
    return full;
  }

  async put(key: string, data: Uint8Array, mime: string): Promise<StoredObject> {
    const full = this.resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(tmp, data, { mode: 0o640 });
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return { key, bytes: data.byteLength, sha256: sha256Hex(data), mime };
  }

  async get(key: string): Promise<Uint8Array> {
    const buf = await readFile(this.resolveKey(key));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const s = await stat(this.resolveKey(key));
      return s.isFile();
    } catch (err) {
      if (err instanceof StorageKeyError) throw err;
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (err) {
      if (err instanceof StorageKeyError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    const probe = `.health/probe-${randomBytes(4).toString("hex")}`;
    try {
      await this.put(probe, new TextEncoder().encode("ok"), "text/plain");
      await this.delete(probe);
      return {
        status: "connected",
        detail: "Filesystem storage writable",
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        meta: { driver: "filesystem" },
      };
    } catch (err) {
      return {
        status: "error",
        detail: `Filesystem storage not writable: ${err instanceof Error ? err.message.replace(this.root, "<root>") : "unknown error"}`,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        meta: { driver: "filesystem" },
      };
    }
  }
}
