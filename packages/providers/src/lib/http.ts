import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isBlockedHostname, isPrivateAddress } from "./ip";

/**
 * Hardened HTTP client used by every adapter.
 *
 *  - AbortController timeout per attempt (covers connect + body read).
 *  - Bounded retries with jittered exponential backoff — ONLY for idempotent
 *    requests (GET/HEAD/OPTIONS by default) or when the caller opts in with
 *    `idempotent: true` / a custom `retryOn`. Non-idempotent POSTs (e.g.
 *    Higgsfield/Kie generate) are never retried unless the caller says so.
 *  - Response size cap (content-length pre-check + streaming cap).
 *  - Manual redirect handling (max 3), re-validating every hop and dropping
 *    credential headers on cross-origin hops.
 *  - `allowHosts`: exact hostnames or "*.suffix" patterns.
 *  - `ssrfGuard`: http/https only, no userinfo, standard ports unless
 *    allow-listed, DNS-resolve ALL addresses and block private/loopback/
 *    link-local/metadata ranges. The default guarded transport re-validates
 *    at connect time via a custom `lookup` (defeats DNS rebinding).
 *  - Error text is redacted (Authorization/Bearer/Key headers, known secret
 *    values, sensitive query parameters).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface LookupAddress {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

export const systemLookup: LookupFn = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export type HttpErrorCode = "timeout" | "network" | "too_large" | "blocked" | "aborted" | "redirect" | "parse";

export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly status?: number;
  constructor(code: HttpErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HttpError";
    this.code = code;
    this.status = opts.status;
  }
}

export interface RetryInfo {
  attempt: number;
  status?: number;
  error?: HttpError;
  method: string;
}

export interface SafeFetchOptions {
  /** Per-attempt timeout (default 30 s). */
  timeoutMs?: number;
  /** Extra attempts after the first (default 0). */
  retries?: number;
  /** Treat the request as idempotent (default: GET/HEAD/OPTIONS). Default retry policy only applies to idempotent requests. */
  idempotent?: boolean;
  /** Custom retry predicate (overrides the default policy entirely). */
  retryOn?: (info: RetryInfo) => boolean;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Response body cap in bytes (default 10 MiB). */
  maxBytes?: number;
  /** Exact hostnames or "*.example.com" patterns. */
  allowHosts?: readonly string[];
  /** Block private/loopback/link-local/metadata destinations after DNS resolution. */
  ssrfGuard?: boolean;
  /** Ports permitted when ssrfGuard is on (default 80, 443). */
  allowPorts?: readonly number[];
  maxRedirects?: number;
  /** Transport override (tests / custom agents). */
  fetch?: FetchLike;
  /** DNS override (tests). */
  lookup?: LookupFn;
  signal?: AbortSignal;
  /** Secret values to scrub from any error text. */
  redact?: readonly (string | undefined | null)[];
  sleep?: (ms: number) => Promise<void>;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  url: string;
  redirected: boolean;
  bytes: Uint8Array;
  text(): string;
  /** Parse JSON; throws HttpError("parse") with a clear, redacted message. */
  json<T = unknown>(): T;
}

const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "freelancer-oauth-v1", "hf-api-key", "hf-secret", "x-webhook-signature"];
const SENSITIVE_QUERY = /([?&](?:access_token|token|key|api_key|apikey|secret|signature|sig|password|auth)=)[^&#]*/gi;

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString().replace(SENSITIVE_QUERY, "$1[redacted]");
  } catch {
    return raw.replace(SENSITIVE_QUERY, "$1[redacted]");
  }
}

/** Scrub credentials from arbitrary text. */
export function redactText(text: string, secrets: readonly (string | undefined | null)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^"'\r\n,}]+/gi, "$1[redacted]")
    .replace(/(freelancer-oauth-v1["']?\s*[:=]\s*["']?)[^"'\r\n,}]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]{6,}/g, "$1 [redacted]")
    .replace(/\bKey\s+[A-Za-z0-9._~+/=-]+:[A-Za-z0-9._~+/=-]+/g, "Key [redacted]")
    .replace(/\b(xai|sk|fk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
    .replace(SENSITIVE_QUERY, "$1[redacted]");
}

function hostAllowed(hostname: string, allow: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

/**
 * Validate a user-configurable URL: scheme, userinfo, port, hostname and every
 * DNS answer. Throws HttpError("blocked") with a secret-free reason.
 */
export async function assertPublicUrl(raw: string, opts: { allowPorts?: readonly number[]; lookup?: LookupFn } = {}): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError("blocked", "invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError("blocked", `scheme ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new HttpError("blocked", "credentials in URL are not allowed");
  const port = effectivePort(u);
  const ports = opts.allowPorts ?? [80, 443];
  if (!ports.includes(port)) throw new HttpError("blocked", `port ${port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new HttpError("blocked", `destination ${host} is a private or reserved address`);
    return { url: u, addresses: [{ address: host, family: isIP(host) }] };
  }
  if (isBlockedHostname(host)) throw new HttpError("blocked", `hostname ${host} is not allowed`);
  let addresses: LookupAddress[];
  try {
    addresses = await (opts.lookup ?? systemLookup)(host);
  } catch (err) {
    throw new HttpError("network", `DNS lookup failed for ${host}`, { cause: err });
  }
  if (!addresses.length) throw new HttpError("network", `DNS lookup returned no addresses for ${host}`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new HttpError("blocked", `hostname ${host} resolves to a private or reserved address`);
  return { url: u, addresses };
}

/**
 * node:http(s) transport whose socket-level DNS lookup rejects private
 * addresses, so the address actually connected to is the one validated.
 */
export function guardedTransport(lookupFn: LookupFn = systemLookup): FetchLike {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(input);
      const mod = u.protocol === "https:" ? https : http;
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const guardedLookup = (hostname: string, options: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
        const all = typeof options === "object" && options?.all === true;
        lookupFn(hostname)
          .then((addrs) => {
            if (!addrs.length) return cb(new Error(`no addresses for ${hostname}`));
            if (addrs.some((a) => isPrivateAddress(a.address))) return cb(new Error(`blocked private address for ${hostname}`));
            if (all) cb(null, addrs);
            else cb(null, addrs[0]!.address, addrs[0]!.family);
          })
          .catch((e: unknown) => cb(e));
      };
      const req = mod.request(
        u,
        { method: init.method ?? "GET", headers, lookup: guardedLookup as never, signal: init.signal ?? undefined },
        (res) => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (v !== undefined) h.set(k, String(v));
          }
          const status = res.statusCode ?? 502;
          const nullBody = status === 204 || status === 304 || (init.method ?? "GET").toUpperCase() === "HEAD";
          if (nullBody) res.resume();
          resolve(new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers: h }));
        },
      );
      req.on("error", reject);
      const body = init.body;
      if (body !== undefined && body !== null) {
        if (typeof body === "string" || body instanceof Uint8Array) req.write(body);
        else {
          req.destroy();
          reject(new Error("guardedTransport supports string/Uint8Array bodies only"));
          return;
        }
      }
      req.end();
    });
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError("too_large", `response exceeds ${maxBytes} bytes (content-length ${len})`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError("too_large", `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const v = headers?.get("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

function defaultRetry(info: RetryInfo, idempotent: boolean): boolean {
  if (!idempotent) return false;
  if (info.error) return info.error.code === "timeout" || info.error.code === "network";
  const s = info.status ?? 0;
  return s === 429 || s === 502 || s === 503 || s === 504 || s === 500;
}

function makeResponse(res: Response, url: string, redirected: boolean, bytes: Uint8Array, secrets: readonly (string | undefined | null)[]): SafeResponse {
  let text: string | undefined;
  const getText = () => (text ??= new TextDecoder().decode(bytes));
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: res.headers,
    url,
    redirected,
    bytes,
    text: getText,
    json<T>() {
      const t = getText();
      if (!t.trim()) throw new HttpError("parse", `empty response body from ${redactUrl(url)} (HTTP ${res.status})`, { status: res.status });
      try {
        return JSON.parse(t) as T;
      } catch {
        const snippet = redactText(t.slice(0, 160).replace(/\s+/g, " "), secrets);
        throw new HttpError("parse", `invalid JSON from ${redactUrl(url)} (HTTP ${res.status}): ${snippet}`, { status: res.status });
      }
    },
  };
}

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = opts.idempotent ?? ["GET", "HEAD", "OPTIONS"].includes(method);
  const retries = Math.max(0, Math.min(opts.retries ?? 0, 5));
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.retryBaseMs ?? 500;
  const cap = opts.retryMaxMs ?? 30_000;
  const secrets = opts.redact ?? [];

  for (let attempt = 0; ; attempt++) {
    let result: SafeResponse | undefined;
    let error: HttpError | undefined;
    try {
      result = await attemptOnce(url, { ...init, method }, opts, secrets);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.code === "blocked" || err.code === "too_large" || err.code === "aborted" || err.code === "redirect") throw err;
      error = err;
    }
    const info: RetryInfo = { attempt, status: result?.status, error, method };
    const shouldRetry = attempt < retries && (opts.retryOn ? opts.retryOn(info) : defaultRetry(info, idempotent));
    if (!shouldRetry) {
      if (error) throw error;
      return result!;
    }
    const backoff = Math.min(cap, base * 2 ** attempt);
    const jittered = backoff / 2 + Math.random() * (backoff / 2);
    const wait = Math.min(cap, retryAfterMs(result?.headers) ?? jittered);
    await sleep(wait);
  }
}

async function attemptOnce(url: string, init: RequestInit & { method: string }, opts: SafeFetchOptions, secrets: readonly (string | undefined | null)[]): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new HttpError("aborted", "request aborted by caller");
    }
    opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const transport: FetchLike = opts.fetch ?? (opts.ssrfGuard ? guardedTransport(opts.lookup) : (i, o) => globalThis.fetch(i, o));

  let current = url;
  let currentInit: RequestInit & { method: string } = { ...init };
  let redirected = false;
  try {
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      if (opts.allowHosts && !hostAllowed(u.hostname, opts.allowHosts)) throw new HttpError("blocked", `host ${u.hostname} is not in the allow-list`);
      if (opts.ssrfGuard) await assertPublicUrl(current, { allowPorts: opts.allowPorts, lookup: opts.lookup });
      else if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError("blocked", `scheme ${u.protocol} is not allowed`);

      let res: Response;
      try {
        res = await transport(current, { ...currentInit, redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (timedOut) throw new HttpError("timeout", `${currentInit.method} ${redactUrl(current)} timed out after ${timeoutMs} ms`, { cause: err });
        if (opts.signal?.aborted) throw new HttpError("aborted", "request aborted by caller", { cause: err });
        const msg = err instanceof Error ? err.message : String(err);
        if (/blocked private address/.test(msg)) throw new HttpError("blocked", `destination for ${u.hostname} resolves to a private or reserved address`);
        throw new HttpError("network", `${currentInit.method} ${redactUrl(current)} failed: ${redactText(msg, secrets)}`, { cause: err });
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new HttpError("redirect", `too many redirects (> ${maxRedirects}) from ${redactUrl(url)}`);
        const next = new URL(location, current);
        const crossOrigin = next.origin !== u.origin;
        const headers = new Headers(currentInit.headers);
        if (crossOrigin) for (const h of SENSITIVE_HEADERS) headers.delete(h);
        let method = currentInit.method;
        let body = currentInit.body;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        currentInit = { ...currentInit, method, body, headers };
        current = next.toString();
        redirected = true;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, maxBytes);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (timedOut) throw new HttpError("timeout", `${currentInit.method} ${redactUrl(current)} timed out after ${timeoutMs} ms (reading body)`, { cause: err });
        if (opts.signal?.aborted) throw new HttpError("aborted", "request aborted by caller", { cause: err });
        throw new HttpError("network", `${currentInit.method} ${redactUrl(current)} body read failed`, { cause: err });
      }
      return makeResponse(res, current, redirected, bytes, secrets);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Short, redacted body snippet for error messages. */
export function bodySnippet(res: SafeResponse, secrets: readonly (string | undefined | null)[] = [], max = 240): string {
  return redactText(res.text().slice(0, max).replace(/\s+/g, " ").trim(), secrets);
}
