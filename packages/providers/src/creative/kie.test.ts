import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreativeModelOption, CreativeRequest } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import { CLEAR_PROVIDER_ENV, PNG_1x1, bytesResponse, jsonResponse, lookupTo, mockFetch, publicLookup, setEnv } from "../lib/testing";
import { KieProvider, buildKieInput, kieCreditsToUsd, parseKieResultUrls, verifyKieWebhook } from "./kie";

const opt = (model: string): CreativeModelOption => CREATIVE_CATALOG.find((o) => o.provider === "kie" && o.model === model)!;
const req = (over: Partial<CreativeRequest> = {}): CreativeRequest => ({ capability: "image.generate", prompt: "a mug on a desk", aspectRatio: "4:5", idempotencyKey: "k1", maxCostUsd: 1, context: { tenantId: undefined }, ...over });
const noSleep = async () => {};

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, KIE_API_KEY: "kie-test-key-123", KIE_BASE_URL: undefined });
});
afterEach(() => restore());

function kieServer(states: Record<string, unknown>[], opts: { create?: () => Response } = {}) {
  let poll = 0;
  return mockFetch((url) => {
    if (url.pathname === "/api/v1/jobs/createTask") return opts.create ? opts.create() : jsonResponse({ code: 200, msg: "success", data: { taskId: "task_abc" } });
    if (url.pathname === "/api/v1/jobs/recordInfo") return jsonResponse({ code: 200, msg: "success", data: states[Math.min(poll++, states.length - 1)] });
    if (url.hostname === "tempfile.aiquickdraw.com") return bytesResponse(PNG_1x1, "image/png");
    return new Response("not found", { status: 404 });
  });
}

describe("KieProvider.generate", () => {
  it("creates, polls, parses resultJson STRING, downloads bytes and costs from creditsConsumed", async () => {
    const f = kieServer([{ state: "waiting" }, { state: "generating" }, { taskId: "task_abc", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://tempfile.aiquickdraw.com/r/abc.png"] }), creditsConsumed: 8 }]);
    const out = await new KieProvider({ fetch: f, lookup: publicLookup, sleep: noSleep }).generate(req(), opt("nano-banana-2"));
    expect(out.status).toBe("succeeded");
    expect(out.externalTaskId).toBe("task_abc");
    expect(out.costUsd).toBeCloseTo(0.04, 6);
    expect(out.costSource).toBe("provider");
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    expect(out.files[0]!.filename).toMatch(/^kie-nano-banana-2-task_abc-1\.png$/);
    const create = JSON.parse(f.calls[0]!.body!);
    expect(create).toEqual({ model: "nano-banana-2", input: { prompt: "a mug on a desk", image_input: [], aspect_ratio: "4:5", resolution: "1K", output_format: "png" } });
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer kie-test-key-123");
  });

  it("maps envelope codes even with HTTP 200 (402 insufficient credits, 422 validation)", async () => {
    const e402 = await new KieProvider({ fetch: kieServer([], { create: () => jsonResponse({ code: 402, msg: "Credits insufficient" }) }), sleep: noSleep }).generate(req(), opt("nano-banana-2")).catch((e) => e);
    expect(e402).toMatchObject({ code: "insufficient_credits" });
    const e422 = await new KieProvider({ fetch: kieServer([], { create: () => jsonResponse({ code: 422, msg: "aspect_ratio invalid" }) }), sleep: noSleep }).generate(req(), opt("nano-banana-2")).catch((e) => e);
    expect(e422).toMatchObject({ code: "validation" });
    const e401 = await new KieProvider({ fetch: kieServer([], { create: () => jsonResponse({ code: 401, msg: "bad key kie-test-key-123" }, 401) }), sleep: noSleep }).generate(req(), opt("nano-banana-2")).catch((e) => e);
    expect(e401.code).toBe("auth");
    expect(e401.message).not.toContain("kie-test-key-123");
    const e455 = await new KieProvider({ fetch: kieServer([], { create: () => jsonResponse({ code: 455, msg: "maintenance" }) }), sleep: noSleep }).generate(req(), opt("nano-banana-2")).catch((e) => e);
    expect(e455).toMatchObject({ code: "unavailable" });
  });

  it("returns a failed output (refunded, cost 0) when the task fails", async () => {
    const out = await new KieProvider({ fetch: kieServer([{ state: "fail", failCode: "501", failMsg: "content policy", creditsConsumed: 0 }]), sleep: noSleep }).generate(req(), opt("nano-banana-2"));
    expect(out).toMatchObject({ status: "failed", costUsd: 0, costSource: "provider", externalTaskId: "task_abc" });
    expect(out.error).toMatch(/content policy/);
  });

  it("times out polling with a conservative catalog cost", async () => {
    const out = await new KieProvider({ fetch: kieServer([{ state: "generating" }]), sleep: noSleep, pollTimeoutMs: 0 }).generate(req(), opt("nano-banana-2"));
    expect(out.status).toBe("failed");
    expect(out.costSource).toBe("catalog");
    expect(out.error).toMatch(/timed out/);
  });

  it("does not trust result URLs that resolve to private addresses", async () => {
    const f = kieServer([{ state: "success", resultJson: '{"resultUrls":["https://tempfile.aiquickdraw.com/x.png"]}', creditsConsumed: 8 }]);
    const out = await new KieProvider({ fetch: f, lookup: lookupTo("169.254.169.254"), sleep: noSleep }).generate(req(), opt("nano-banana-2"));
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/download failed/);
    expect(out.costUsd).toBeCloseTo(0.04, 6); // credits were consumed; the ledger must still record them
  });

  it("refuses when the catalog estimate exceeds maxCostUsd (nothing sent)", async () => {
    const f = kieServer([]);
    await expect(new KieProvider({ fetch: f }).generate(req({ maxCostUsd: 0.01 }), opt("nano-banana-2"))).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(f.calls).toHaveLength(0);
    await expect(new KieProvider({ fetch: f }).generate(req(), opt("topaz/image-upscale"))).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("is not configured without a key", async () => {
    const r = setEnv({ KIE_API_KEY: undefined });
    const k = new KieProvider();
    expect(k.isConfigured()).toBe(false);
    await expect(k.generate(req(), opt("nano-banana-2"))).rejects.toMatchObject({ code: "not_configured" });
    expect((await k.health()).status).toBe("needs_configuration");
    r();
  });
});

describe("Kie helpers", () => {
  it("parses resultJson as string or object, rejects junk", () => {
    expect(parseKieResultUrls('{"resultUrls":["https://a/1.png","https://a/2.png"]}')).toEqual(["https://a/1.png", "https://a/2.png"]);
    expect(parseKieResultUrls({ resultUrls: ["https://a/1.mp4"] })).toEqual(["https://a/1.mp4"]);
    expect(parseKieResultUrls("{not json")).toEqual([]);
    expect(parseKieResultUrls('{"resultUrls":["javascript:alert(1)"]}')).toEqual([]);
    expect(parseKieResultUrls(null)).toEqual([]);
  });

  it("converts credits to USD", () => {
    expect(kieCreditsToUsd(60)).toBeCloseTo(0.3);
    expect(kieCreditsToUsd("11.7")).toBeCloseTo(0.0585);
    expect(kieCreditsToUsd("abc")).toBeUndefined();
  });

  it("maps model inputs per docs", () => {
    expect(buildKieInput("google/imagen4-fast", req({ aspectRatio: "3:2", negativePrompt: "blurry" }))).toEqual({ prompt: "a mug on a desk", negative_prompt: "blurry", aspect_ratio: "4:3" });
    expect(buildKieInput("veo-3-1", req({ capability: "video.generate", aspectRatio: "9:16", durationSec: 5 }))).toMatchObject({ aspect_ratio: "9:16", resolution: "720p", duration: 6, generation_type: "TEXT_2_VIDEO" });
    expect(buildKieInput("kling-3.0/video", req({ capability: "video.image_to_video", durationSec: 20, referenceAssetUrls: ["https://cdn/x.png"] }))).toMatchObject({ duration: "15", image_urls: ["https://cdn/x.png"], mode: "std", sound: false });
    expect(buildKieInput("bytedance/seedance-2-fast", req({ capability: "video.generate", aspectRatio: "4:5", durationSec: 8 }))).toMatchObject({ aspect_ratio: "3:4", duration: 8, resolution: "480p" });
    expect(() => buildKieInput("google/nano-banana-edit", req({ capability: "image.edit" }))).toThrow(/reference image/);
    expect(buildKieInput("google/nano-banana-edit", req({ capability: "image.edit", referenceAssetUrls: ["http://insecure/x.png", "https://cdn/y.png"] }))).toMatchObject({ image_urls: ["https://cdn/y.png"] });
  });

  it("verifies webhooks with taskId or task_id and rejects replays/forgeries", () => {
    const key = "hmac-key";
    const ts = "1790000000";
    const sig = createHmac("sha256", key).update(`task_1.${ts}`).digest("base64");
    const headers = { "X-Webhook-Timestamp": ts, "X-Webhook-Signature": sig };
    expect(verifyKieWebhook(headers, { taskId: "task_1" }, key, { nowSec: 1790000100 })).toEqual({ ok: true, taskId: "task_1" });
    expect(verifyKieWebhook(new Headers(headers), JSON.stringify({ code: 200, data: { task_id: "task_1" } }), key, { nowSec: 1790000100 }).ok).toBe(true);
    expect(verifyKieWebhook(headers, { taskId: "task_2" }, key, { nowSec: 1790000100 }).ok).toBe(false);
    expect(verifyKieWebhook(headers, { taskId: "task_1" }, "wrong", { nowSec: 1790000100 }).ok).toBe(false);
    expect(verifyKieWebhook(headers, { taskId: "task_1" }, key, { nowSec: 1790009999 }).reason).toMatch(/window/);
    expect(verifyKieWebhook({}, { taskId: "task_1" }, key).ok).toBe(false);
    expect(verifyKieWebhook(headers, { taskId: "task_1" }, undefined).ok).toBe(false);
  });
});

describe("KieProvider.health", () => {
  it("reports the credit balance", async () => {
    const f = mockFetch(() => jsonResponse({ code: 200, msg: "success", data: 1234 }));
    const h = await new KieProvider({ fetch: f }).health();
    expect(h.status).toBe("connected");
    expect(h.meta).toMatchObject({ credits: 1234, creditsUsd: 6.17 });
    expect(f.calls[0]!.url).toBe("https://api.kie.ai/api/v1/chat/credit");
    const zero = await new KieProvider({ fetch: mockFetch(() => jsonResponse({ code: 200, data: 0 })) }).health();
    expect(zero.status).toBe("degraded");
    const bad = await new KieProvider({ fetch: mockFetch(() => jsonResponse({ code: 401, msg: "unauthorized" }, 401)) }).health();
    expect(bad.status).toBe("error");
  });
});
