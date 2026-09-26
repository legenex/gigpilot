import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { marketInsightSchema } from "@gigpilot/contracts";
import { CLEAR_PROVIDER_ENV, jsonResponse, mockFetch, setEnv } from "../lib/testing";
import { GrokProvider, extractCitations } from "./grok";

// Low-entropy fake credential built at runtime (keeps secret scanners quiet).
const FAKE_XAI = ["xai", "t".repeat(20)].join("-");

function responseBody(text: string, usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 200, cost_in_usd_ticks: 37_756_000 }, extra: Record<string, unknown> = {}) {
  return { id: "resp_1", model: "grok-4.3", status: "completed", output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://b.example.com/", title: "B" }] }] }], usage, ...extra };
}

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, XAI_API_KEY: FAKE_XAI, XAI_MODEL: undefined, XAI_MODEL_PREMIUM: undefined, XAI_BASE_URL: undefined });
});
afterEach(() => restore());

describe("GrokProvider", () => {
  it("calls the Responses API with web_search tools and parses provider cost ticks + citations", async () => {
    const f = mockFetch(() => jsonResponse(responseBody("Market is hot.", undefined, { citations: ["https://a.example.com/", { url: "https://b.example.com/", title: "B" }] })));
    const res = await new GrokProvider({ fetch: f }).complete({ task: "web_research", webSearch: true, messages: [{ role: "user", content: "What is trending?" }] });
    expect(res.text).toBe("Market is hot.");
    expect(res.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, costSource: "provider" });
    expect(res.usage.costUsd).toBeCloseTo(0.0037756, 7);
    expect(res.citations).toEqual([{ url: "https://a.example.com/" }, { url: "https://b.example.com/", title: "B" }]);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/responses");
    const body = JSON.parse(call.body!);
    expect(body.model).toBe("grok-4.3");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.search_parameters).toBeUndefined();
    expect(body.max_turns).toBeGreaterThan(0);
    expect(call.headers.get("authorization")).toBe(`Bearer ${FAKE_XAI}`);
  });

  it("adds x_search for market research and uses the premium model for qa_high", async () => {
    const f = mockFetch(() => jsonResponse(responseBody("ok")));
    const g = new GrokProvider({ fetch: f });
    await g.complete({ task: "market_research", webSearch: true, messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(f.calls[0]!.body!).tools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
    await g.complete({ task: "qa_high", messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(f.calls[1]!.body!).model).toBe("grok-4.7");
    expect(g.modelFor("summarise")).toBe("grok-4.3");
  });

  it("uses strict json_schema structured output and validates with zod", async () => {
    const data = { headline: "H", summary: "S", recommendations: [{ marketKey: "ugc", action: "increase", reason: "demand" }], signals: [] };
    const f = mockFetch(() => jsonResponse(responseBody(JSON.stringify(data))));
    const res = await new GrokProvider({ fetch: f }).complete({ task: "market_research", schema: marketInsightSchema, messages: [{ role: "user", content: "x" }] });
    expect(res.data?.headline).toBe("H");
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "MarketInsight", strict: true });
    expect(body.text.format.schema.type).toBe("object");
  });

  it("falls back to catalog cost (+ $0.005 per search call) when ticks are missing", async () => {
    const f = mockFetch(() => jsonResponse(responseBody("x", { input_tokens: 1_000_000, output_tokens: 0 })));
    const res = await new GrokProvider({ fetch: f }).complete({ task: "web_research", webSearch: true, messages: [{ role: "user", content: "x" }] });
    expect(res.usage.costSource).toBe("catalog");
    expect(res.usage.costUsd).toBeCloseTo(1.25 + 0.005, 6);
  });

  it("repairs invalid structured output only within maxCostUsd", async () => {
    const schema = z.object({ n: z.number().max(1) });
    let n = 0;
    const f = mockFetch(() => jsonResponse(responseBody(++n === 1 ? '{"n":5}' : '{"n":0.5}')));
    const res = await new GrokProvider({ fetch: f }).complete({ task: "classify", schema, messages: [{ role: "user", content: "x" }] });
    expect(res.data).toEqual({ n: 0.5 });
    expect(res.usage.costUsd).toBeCloseTo(0.0075512, 6);

    const f2 = mockFetch(() => jsonResponse(responseBody('{"n":5}', { input_tokens: 10, output_tokens: 10, cost_in_usd_ticks: 1e8 })));
    await expect(new GrokProvider({ fetch: f2 }).complete({ task: "classify", schema, maxCostUsd: 0.015, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "structured_output" });
    expect(f2.calls).toHaveLength(1);
  });

  it("refuses over-budget calls before any request and maps HTTP errors without leaking the key", async () => {
    const f = mockFetch(() => jsonResponse(responseBody("x")));
    await expect(new GrokProvider({ fetch: f }).complete({ task: "web_research", webSearch: true, maxCostUsd: 0.001, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(f.calls).toHaveLength(0);
    const e = await new GrokProvider({ fetch: mockFetch(() => jsonResponse({ error: `Incorrect API key provided: ${FAKE_XAI}` }, 401)) })
      .complete({ task: "summarise", messages: [{ role: "user", content: "x" }] })
      .catch((err) => err);
    expect(e.code).toBe("auth");
    expect(e.message).not.toContain(FAKE_XAI);
    const bad = await new GrokProvider({ fetch: mockFetch(() => new Response("{not json", { status: 200 })) }).complete({ task: "summarise", messages: [{ role: "user", content: "x" }] }).catch((err) => err);
    expect(bad.code).toBe("bad_response");
  });

  it("health uses GET /api-key and reports blocked flags; needs_configuration without a key", async () => {
    const f = mockFetch(() => jsonResponse({ name: "gigpilot", redacted_api_key: "xai-...7890", api_key_blocked: false, api_key_disabled: false, team_blocked: false }));
    const h = await new GrokProvider({ fetch: f }).health();
    expect(h.status).toBe("connected");
    expect(f.calls[0]!.url).toBe("https://api.x.ai/v1/api-key");
    expect(f.calls[0]!.method).toBe("GET");
    expect(JSON.stringify(h)).not.toContain("7890");
    const blocked = await new GrokProvider({ fetch: mockFetch(() => jsonResponse({ api_key_blocked: true })) }).health();
    expect(blocked.status).toBe("error");
    const r = setEnv({ XAI_API_KEY: undefined });
    expect(new GrokProvider().isConfigured()).toBe(false);
    expect((await new GrokProvider().health()).status).toBe("needs_configuration");
    await expect(new GrokProvider().complete({ task: "summarise", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "not_configured" });
    r();
  });

  it("estimates cost including web search", () => {
    const g = new GrokProvider();
    const base = g.estimateCost({ task: "summarise", messages: [{ role: "user", content: "x".repeat(4000) }] });
    const web = g.estimateCost({ task: "web_research", webSearch: true, messages: [{ role: "user", content: "x".repeat(4000) }] });
    expect(base).toBeGreaterThan(0);
    expect(web - base).toBeGreaterThanOrEqual(0.02);
  });

  it("extracts only http(s) citations", () => {
    expect(extractCitations({ citations: ["javascript:alert(1)", "https://ok.example/"] })).toEqual([{ url: "https://ok.example/" }]);
  });
});
