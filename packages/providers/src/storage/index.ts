import { existsSync } from "node:fs";
import path from "node:path";
import type { StorageAdapter } from "../types";
import { FilesystemStorage } from "./filesystem";
import { S3Storage } from "./s3";

export { FilesystemStorage } from "./filesystem";
export { S3Storage } from "./s3";
export { StorageKeyError, assertSafeKey, buildAssetKey, safeFilename, sha256Hex } from "./keys";

interface StorageGlobal {
  __gigpilotStorage?: StorageAdapter;
}
const g = globalThis as unknown as StorageGlobal;

/**
 * Process-wide storage adapter. STORAGE_DRIVER=filesystem (default) roots at
 * STORAGE_ROOT (default ./var/storage); STORAGE_DRIVER=s3 uses the S3 driver.
 */
export function getStorage(): StorageAdapter {
  if (!g.__gigpilotStorage) g.__gigpilotStorage = createStorage();
  return g.__gigpilotStorage;
}

export function createStorage(envVars: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const driver = (envVars.STORAGE_DRIVER ?? "filesystem").trim();
  if (driver === "s3") {
    return new S3Storage({
      endpoint: envVars.S3_ENDPOINT?.trim() || undefined,
      bucket: envVars.S3_BUCKET?.trim() || undefined,
      region: envVars.S3_REGION?.trim() || undefined,
      accessKeyId: envVars.S3_ACCESS_KEY_ID?.trim() || undefined,
      secretAccessKey: envVars.S3_SECRET_ACCESS_KEY?.trim() || undefined,
    });
  }
  return new FilesystemStorage(resolveStorageRoot(envVars.STORAGE_ROOT?.trim() || "./var/storage"));
}

/**
 * Relative roots resolve against the monorepo root (nearest ancestor with
 * pnpm-workspace.yaml) so the worker and dashboard — which run from different
 * package directories in dev — share one storage tree. Absolute roots are
 * used as-is (Docker / gx10-01).
 */
export function resolveStorageRoot(root: string, cwd: string = process.cwd()): string {
  if (path.isAbsolute(root)) return root;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.resolve(dir, root);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd, root);
}

/** Tests only: replace or reset the process-wide adapter. */
export function setStorageForTesting(adapter: StorageAdapter | undefined): void {
  g.__gigpilotStorage = adapter;
}
