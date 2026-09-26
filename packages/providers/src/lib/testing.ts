/**
 * TEST-ONLY helpers (mock transports, env sandboxing). Not exported from the
 * package entry point.
 */
import type { FetchLike, LookupFn } from "./http";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

export type MockHandler = (url: URL, call: RecordedCall) => Response | Promise<Response>;

export function mockFetch(handler: MockHandler): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string, init: RequestInit = {}) => {
    const call: RecordedCall = { url: input, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(new URL(input), call);
  }) as FetchLike & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function bytesResponse(bytes: Uint8Array, mime: string, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, { status, headers: { "content-type": mime, "content-length": String(bytes.byteLength) } });
}

/** A fetch that only settles when aborted (simulates a hung upstream). */
export function hangingFetch(): FetchLike & { calls: number } {
  const fn = ((_input: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      fn.calls++;
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as FetchLike & { calls: number };
  fn.calls = 0;
  return fn;
}

export const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

export function lookupTo(address: string): LookupFn {
  return async () => [{ address, family: address.includes(":") ? 6 : 4 }];
}

/** Minimal valid PNG header (1x1) followed by padding. */
export const PNG_1x1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);

/** Set env vars for a test; returns a restore function. `undefined` deletes. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** All provider credential env vars cleared (tests start from "nothing configured"). */
export const CLEAR_PROVIDER_ENV: Record<string, undefined> = {
  FACTORY_API_KEY: undefined,
  FACTORY_DROID_BIN: undefined,
  FACTORY_MODEL: undefined,
  GX_BASE_URL: undefined,
  GX_API_KEY: undefined,
  XAI_API_KEY: undefined,
  KIE_API_KEY: undefined,
  KIE_WEBHOOK_HMAC_KEY: undefined,
  HIGGSFIELD_API_KEY: undefined,
  HIGGSFIELD_API_SECRET: undefined,
  UPWORK_CLIENT_ID: undefined,
  UPWORK_CLIENT_SECRET: undefined,
  UPWORK_ACCESS_TOKEN: undefined,
  FREELANCER_OAUTH_TOKEN: undefined,
  FREELANCER_BASE_URL: undefined,
  INBOUND_WEBHOOK_SECRET: undefined,
  AGENTOS_STATUS_FILE: undefined,
  AGENTOS_BASE_URL: undefined,
  AGENTOS_PUSH_ENABLED: undefined,
  AGENTOS_SUPERVISION_TOKEN: undefined,
};
