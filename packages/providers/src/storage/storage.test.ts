import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemStorage } from "./filesystem";
import { assertSafeKey, buildAssetKey, safeFilename, sha256Hex, StorageKeyError } from "./keys";
import { createStorage, resolveStorageRoot } from "./index";
import { S3Storage } from "./s3";

const root = () => mkdtempSync(path.join(os.tmpdir(), "gigpilot-storage-test-"));

describe("storage keys", () => {
  it.each([
    "../etc/passwd",
    "tenants/../../etc/passwd",
    "/etc/passwd",
    "tenants/a/./b",
    "tenants\\a\\b",
    "C:/windows/system32",
    "tenants/a\0b",
    "tenants//a",
    "",
    "tenants/a b/c",
  ])("rejects unsafe key %j", (key) => {
    expect(() => assertSafeKey(key)).toThrow(StorageKeyError);
  });

  it("builds canonical tenant/job keys with a sha prefix and safe filename", () => {
    const sha = sha256Hex(new TextEncoder().encode("hello"));
    const key = buildAssetKey({ tenantId: "5b1c-1", jobId: "j-1", filename: "../../Évil name?.SVG", sha256: sha });
    expect(key).toBe(`tenants/5b1c-1/jobs/j-1/${sha.slice(0, 16)}-Evil-name.svg`);
    expect(safeFilename("a/b/c.tar.gz")).toBe("c.tar.gz");
    expect(() => buildAssetKey({ tenantId: "../x", filename: "a", sha256: sha })).toThrow(StorageKeyError);
  });
});

describe("FilesystemStorage", () => {
  it("round-trips bytes atomically with sha256 and leaves no temp files", async () => {
    const dir = root();
    const s = new FilesystemStorage(dir);
    const data = new TextEncoder().encode("<svg/>");
    const stored = await s.put("tenants/t/jobs/j/abc-file.svg", data, "image/svg+xml");
    expect(stored.sha256).toBe(sha256Hex(data));
    expect(stored.bytes).toBe(data.byteLength);
    expect(new TextDecoder().decode(await s.get("tenants/t/jobs/j/abc-file.svg"))).toBe("<svg/>");
    expect(await s.exists("tenants/t/jobs/j/abc-file.svg")).toBe(true);
    expect(readdirSync(path.join(dir, "tenants/t/jobs/j"))).toEqual(["abc-file.svg"]);
    await s.delete("tenants/t/jobs/j/abc-file.svg");
    expect(await s.exists("tenants/t/jobs/j/abc-file.svg")).toBe(false);
    expect((await s.health()).status).toBe("connected");
  });

  it("rejects traversal on every operation", async () => {
    const s = new FilesystemStorage(root());
    await expect(s.put("../escape.txt", new Uint8Array([1]), "text/plain")).rejects.toThrow(StorageKeyError);
    await expect(s.get("tenants/../../escape")).rejects.toThrow(StorageKeyError);
    await expect(s.exists("/etc/passwd")).rejects.toThrow(StorageKeyError);
    await expect(s.delete("..")).rejects.toThrow(StorageKeyError);
    expect(() => s.resolveKey("tenants/%2e%2e/x")).toThrow(StorageKeyError); // percent-encoding is not an allowed key character
  });

  it("resolves relative roots against the monorepo root and selects drivers from env", () => {
    const resolved = resolveStorageRoot("./var/storage", path.join(process.cwd(), "packages", "providers"));
    expect(resolved.endsWith(path.join("var", "storage"))).toBe(true);
    expect(resolveStorageRoot("/srv/x")).toBe("/srv/x");
    expect(createStorage({ STORAGE_DRIVER: "filesystem", STORAGE_ROOT: root() } as NodeJS.ProcessEnv).driver).toBe("filesystem");
    expect(createStorage({ STORAGE_DRIVER: "s3" } as NodeJS.ProcessEnv).driver).toBe("s3");
  });
});

describe("S3Storage", () => {
  it("reports needs_configuration instead of crashing when env is missing", async () => {
    const s = new S3Storage({});
    expect((await s.health()).status).toBe("needs_configuration");
    await expect(s.put("tenants/t/a.txt", new Uint8Array([1]), "text/plain")).rejects.toThrow(/not configured/);
    await expect(s.put("../a", new Uint8Array([1]), "text/plain")).rejects.toThrow(StorageKeyError);
  });
});
