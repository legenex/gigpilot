import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreativeModelOption, CreativeRequest } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import { CLEAR_PROVIDER_ENV, PNG_1x1, bytesResponse, hangingFetch, jsonResponse, mockFetch, publicLookup, setEnv } from "../lib/testing";
import { HiggsfieldProvider, buildHiggsfieldBody, higgsfieldEndpoint } from "./higgsfield";

const opt = (model: string): CreativeModelOption => CREATIVE_CATALOG.find((o) => o.provider === "higgsfield" && o.model === model)!;
const req = (over: Partial<CreativeRequest> = {}): CreativeRequest => ({ capability: "image.generate", prompt: "portrait", aspectRatio: "9:16", idempotencyKey: "k", maxCostUsd: 0.5, ...over });
const noSleep = async () => {};
const REQ_ID = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, HIGGSFIELD_API_KEY: "hf-key-id", HIGGSFIELD_API_SECRET: "hf-secret-value", HIGGSFIELD_BASE_URL: undefined });
});
afterEach(() => restore());

function server(opts: { estimate?: () => Response; generate?: () => Response | Promise<Response>; statuses?: Record<string, unknown>[] } = {}) {
  let poll = 0;
  const statuses = opts.statuses ?? [{ status: "in_progress", request_id: REQ_ID }, { status: "completed", request_id: REQ_ID, images: [{ url: "https://cdn.higgsfield.ai/out/1.png" }] }];
  return mockFetch((url) => {
    if (url.pathname.startsWith("/estimate/")) return opts.estimate ? opts.estimate() : jsonResponse({ credits: "1.500", usd: "0.094" });
    if (url.pathname === "/higgsfield-ai/soul/v2/standard" || url.pathname === "/kling-video/v3.0/pro/image-to-video") return opts.generate ? opts.generate() : jsonResponse({ status: "queued", request_id: REQ_ID });
    if (url.pathname === `/requests/${REQ_ID}/status`) return jsonResponse(statuses[Math.min(poll++, statuses.length - 1)]);
    if (url.hostname === "cdn.higgsfield.ai") return bytesResponse(PNG_1x1, "image/png");
    return new Response("nf", { status: 404 });
  });
}

const generateCalls = (f: ReturnType<typeof mockFetch>) => f.calls.filter((c) => c.method === "POST" && !c.url.includes("/estimate/"));

describe("HiggsfieldProvider.generate", () => {
  it("estimates (free), generates once, polls, downloads, and records the estimate as cost", async () => {
    const f = server();
    const out = await new HiggsfieldProvider({ fetch: f, lookup: publicLookup, sleep: noSleep }).generate(req(), opt("higgsfield-ai/soul/v2/standard"));
    expect(out.status).toBe("succeeded");
    expect(out.costUsd).toBeCloseTo(0.094, 6);
    expect(out.costSource).toBe("provider");
    expect(out.files[0]).toMatchObject({ mime: "image/png" });
    expect(f.calls[0]!.url).toBe("https://api.higgsfield.ai/estimate/higgsfield-ai/soul/v2/standard");
    expect(f.calls[0]!.headers.get("authorization")).toBe("Key hf-key-id:hf-secret-value");
    expect(generateCalls(f)).toHaveLength(1);
    expect(JSON.parse(generateCalls(f)[0]!.body!)).toEqual({ prompt: "portrait", aspect_ratio: "9:16" });
  });

  it("NEVER retries the generate POST after a timeout (ambiguous submission)", async () => {
    const hung = hangingFetch();
    const f = mockFetch((url, call) => {
      if (url.pathname.startsWith("/estimate/")) return jsonResponse({ usd: "0.01", credits: "0.2" });
      return hung(call.url, { signal: AbortSignal.timeout(20) });
    });
    const err = await new HiggsfieldProvider({ fetch: f, sleep: noSleep }).generate(req(), opt("higgsfield-ai/soul/v2/standard")).catch((e) => e);
    expect(err.code).toBe("ambiguous_submission");
    expect(err.retryable).toBe(false);
    expect(generateCalls(f)).toHaveLength(1);
  });

  it("does not retry the generate POST on 5xx either", async () => {
    const f = server({ generate: () => new Response(JSON.stringify({ detail: "Internal error" }), { status: 500 }) });
    const err = await new HiggsfieldProvider({ fetch: f, sleep: noSleep }).generate(req(), opt("higgsfield-ai/soul/v2/standard")).catch((e) => e);
    expect(err.code).toBe("provider_error");
    expect(err.retryable).toBe(false);
    expect(generateCalls(f)).toHaveLength(1);
  });

  it("maps 400 concurrency limits, 403 credits and 401 auth", async () => {
    const conc = await new HiggsfieldProvider({ fetch: server({ generate: () => jsonResponse({ detail: "Concurrency limit reached for your account" }, 400) }) }).generate(req(), opt("higgsfield-ai/soul/v2/standard")).catch((e) => e);
    expect(conc).toMatchObject({ code: "concurrency_limit", retryable: true });
    const credits = await new HiggsfieldProvider({ fetch: server({ generate: () => jsonResponse({ detail: "Not enough credits" }, 403) }) }).generate(req(), opt("higgsfield-ai/soul/v2/standard")).catch((e) => e);
    expect(credits.code).toBe("insufficient_credits");
    const auth = await new HiggsfieldProvider({ fetch: server({ estimate: () => jsonResponse({ detail: "Invalid credentials" }, 401) }) }).generate(req(), opt("higgsfield-ai/soul/v2/standard")).catch((e) => e);
    expect(auth.code).toBe("auth");
    expect(auth.message).not.toContain("hf-secret-value");
  });

  it("refuses when the estimate exceeds maxCostUsd (generate never called)", async () => {
    const f = server({ estimate: () => jsonResponse({ usd: "2.50", credits: "40" }) });
    await expect(new HiggsfieldProvider({ fetch: f }).generate(req(), opt("higgsfield-ai/soul/v2/standard"))).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(generateCalls(f)).toHaveLength(0);
  });

  it("returns failed with zero cost for nsfw / failed requests", async () => {
    const f = server({ statuses: [{ status: "nsfw", request_id: REQ_ID }] });
    const out = await new HiggsfieldProvider({ fetch: f, sleep: noSleep }).generate(req(), opt("higgsfield-ai/soul/v2/standard"));
    expect(out).toMatchObject({ status: "failed", costUsd: 0, externalTaskId: REQ_ID });
    expect(out.error).toMatch(/NSFW/);
  });

  it("builds bodies per capability and validates endpoint overrides", () => {
    expect(buildHiggsfieldBody(opt("kling-video/v3.0/pro/image-to-video"), req({ capability: "video.image_to_video", durationSec: 8, referenceAssetUrls: ["https://cdn/x.png"] }))).toEqual({ prompt: "portrait", image_url: "https://cdn/x.png", duration: 10 });
    expect(() => buildHiggsfieldBody(opt("kling-video/v3.0/pro/image-to-video"), req({ capability: "video.image_to_video" }))).toThrow(/start image/);
    expect(higgsfieldEndpoint(opt("z-image/turbo"))).toBe("z-image/turbo");
    expect(() => higgsfieldEndpoint(opt("z-image/turbo"), req({ params: { endpoint: "../requests/x" } }))).toThrow(/invalid endpoint/);
    expect(() => higgsfieldEndpoint(opt("z-image/turbo"), req({ params: { endpoint: "https://evil.example/x" } }))).toThrow(/invalid endpoint/);
  });
});

describe("HiggsfieldProvider.health", () => {
  it("uses the free estimate endpoint", async () => {
    const f = server();
    const h = await new HiggsfieldProvider({ fetch: f }).health();
    expect(h.status).toBe("connected");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.higgsfield.ai/estimate/higgsfield-ai/soul/v2/standard");
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ prompt: "x" });
    const bad = await new HiggsfieldProvider({ fetch: server({ estimate: () => jsonResponse({ detail: "Invalid credentials" }, 401) }) }).health();
    expect(bad.status).toBe("error");
    const r = setEnv({ HIGGSFIELD_API_SECRET: undefined });
    expect(new HiggsfieldProvider().isConfigured()).toBe(false);
    expect((await new HiggsfieldProvider().health()).status).toBe("needs_configuration");
    r();
  });
});
