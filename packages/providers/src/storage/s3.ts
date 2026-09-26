import { createHash, createHmac } from "node:crypto";
import type { ProviderHealth } from "@gigpilot/contracts";
import type { StorageAdapter, StoredObject } from "../types";
import { assertSafeKey, sha256Hex } from "./keys";

/**
 * S3-compatible object storage (AWS S3, MinIO, R2, B2…) using path-style
 * requests signed with AWS Signature V4 over native fetch — no vendor SDK.
 * Selected with STORAGE_DRIVER=s3; missing configuration surfaces as a
 * `needs_configuration` health status instead of a crash.
 */

export interface S3Config {
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** RFC 3986 encoding as required by SigV4 (keeps unreserved characters). */
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class S3Storage implements StorageAdapter {
  readonly driver = "s3" as const;

  constructor(private readonly cfg: S3Config) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.bucket && this.cfg.region && this.cfg.accessKeyId && this.cfg.secretAccessKey);
  }

  private endpoint(): string {
    return (this.cfg.endpoint?.replace(/\/+$/, "") || `https://s3.${this.cfg.region}.amazonaws.com`).trim();
  }

  private requireConfig(): Required<Omit<S3Config, "endpoint">> {
    if (!this.isConfigured()) throw new Error("S3 storage is not configured (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)");
    return this.cfg as Required<Omit<S3Config, "endpoint">>;
  }

  private async request(method: "GET" | "PUT" | "HEAD" | "DELETE", key: string | null, body?: Uint8Array, contentType?: string): Promise<Response> {
    const cfg = this.requireConfig();
    const base = new URL(this.endpoint());
    const objectPath = key === null ? "" : `/${key.split("/").map(encodeRfc3986).join("/")}`;
    const canonicalUri = `${base.pathname.replace(/\/+$/, "")}/${encodeRfc3986(cfg.bucket)}${objectPath}`;
    const url = `${base.origin}${canonicalUri}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? new Uint8Array());
    const headers: Record<string, string> = {
      host: base.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, cfg.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const { host: _host, ...sendHeaders } = headers;
    return fetch(url, {
      method,
      headers: { ...sendHeaders, authorization },
      body: body && method === "PUT" ? Buffer.from(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  async put(key: string, data: Uint8Array, mime: string): Promise<StoredObject> {
    assertSafeKey(key);
    const res = await this.request("PUT", key, data, mime);
    if (!res.ok) throw new Error(`S3 put failed: HTTP ${res.status}`);
    return { key, bytes: data.byteLength, sha256: sha256Hex(data), mime };
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    const res = await this.request("GET", key);
    if (!res.ok) throw new Error(`S3 get failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const res = await this.request("HEAD", key);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`S3 head failed: HTTP ${res.status}`);
    return true;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: HTTP ${res.status}`);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        status: "needs_configuration",
        detail: "S3 storage selected but S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not all set",
        checkedAt,
        meta: { driver: "s3" },
      };
    }
    const started = Date.now();
    try {
      const res = await this.request("HEAD", null);
      const latencyMs = Date.now() - started;
      if (res.ok) return { status: "connected", detail: "S3 bucket reachable", latencyMs, checkedAt, meta: { driver: "s3" } };
      if (res.status === 403 || res.status === 401) return { status: "error", detail: "S3 credentials rejected", latencyMs, checkedAt, meta: { driver: "s3" } };
      return { status: "degraded", detail: `S3 bucket check returned HTTP ${res.status}`, latencyMs, checkedAt, meta: { driver: "s3" } };
    } catch (err) {
      return {
        status: "unavailable",
        detail: `S3 endpoint unreachable: ${err instanceof Error ? err.name : "error"}`,
        latencyMs: Date.now() - started,
        checkedAt,
        meta: { driver: "s3" },
      };
    }
  }
}
