import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { opportunityAnalysisSchema } from "@gigpilot/contracts";
import { setTenantSecretLookup } from "../lib/credentials";
import { ProviderError } from "../lib/errors";
import { CLEAR_PROVIDER_ENV, hangingFetch, jsonResponse, mockFetch, setEnv } from "../lib/testing";
import { GxProvider, resetGxFormatSupport } from "./gx";
import { opportunityAnalysisUserPrompt } from "./prompts";

const schema = z.object({ label: z.string(), score: z.number().min(0).max(1) });

function completion(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return jsonResponse({ model: "gx-mini", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage });
}

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, GX_BASE_URL: "http://gx.test/v1", GX_API_KEY: "gx-test-key", GX_TIMEOUT_MS: undefined, GX_MAX_CONCURRENCY: undefined });
  resetGxFormatSupport();
});
afterEach(() => {
  restore();
  setTenantSecretLookup(null);
});

describe("GxProvider", () => {
  it("returns validated structured data with json_schema response_format and $0 cost", async () => {
    const f = mockFetch(() => completion('```json\n{"label":"ugc","score":0.8}\n```'));
    const gx = new GxProvider({ fetch: f });
    const res = await gx.complete({ task: "classify", schema, schemaName: "Label", messages: [{ role: "user", content: "classify" }] });
    expect(res.data).toEqual({ label: "ugc", score: 0.8 });
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0, costSource: "free" });
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.model).toBe("gx-mini");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("JSON Schema for Label");
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer gx-test-key");
  });

  it("routes reasoning tasks to gx-code and never uses gx-max", async () => {
    const gx = new GxProvider();
    expect(gx.modelFor("analyse_opportunity")).toBe("gx-code");
    expect(gx.modelFor("proposal")).toBe("gx-code");
    expect(gx.modelFor("triage")).toBe("gx-mini");
    expect(() => new GxProvider({ model: "gx-max" }).modelFor("triage")).toThrow(/gx-max/);
    const r = setEnv({ GX_MODEL_CODE: "gx-max" });
    expect(() => gx.modelFor("code")).toThrow(ProviderError);
    r();
  });

  it("does one repair round-trip on invalid output", async () => {
    let n = 0;
    const f = mockFetch(() => completion(++n === 1 ? '{"label":"x","score":7}' : '{"label":"x","score":0.7}'));
    const res = await new GxProvider({ fetch: f }).complete({ task: "classify", schema, messages: [{ role: "user", content: "go" }] });
    expect(res.data).toEqual({ label: "x", score: 0.7 });
    expect(f.calls).toHaveLength(2);
    const repair = JSON.parse(f.calls[1]!.body!);
    expect(repair.messages.at(-1).content).toMatch(/score/);
    expect(repair.messages.at(-2)).toMatchObject({ role: "assistant", content: '{"label":"x","score":7}' });
    expect(res.usage.inputTokens).toBe(200);
  });

  it("fails with structured_output after the single repair", async () => {
    const f = mockFetch(() => completion("not json at all"));
    const err = await new GxProvider({ fetch: f }).complete({ task: "classify", schema, messages: [{ role: "user", content: "go" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("structured_output");
    expect(f.calls).toHaveLength(2);
  });

  it("falls back to json_object when the backend rejects json_schema, and remembers it", async () => {
    const f = mockFetch((_u, call) => {
      const body = JSON.parse(call.body!);
      if (body.response_format?.type === "json_schema") return jsonResponse({ error: { message: "response_format json_schema not supported" } }, 400);
      return completion('{"label":"a","score":0.1}');
    });
    const gx = new GxProvider({ fetch: f });
    await gx.complete({ task: "classify", schema, messages: [{ role: "user", content: "go" }] });
    await gx.complete({ task: "classify", schema, messages: [{ role: "user", content: "go" }] });
    expect(f.calls.map((c) => JSON.parse(c.body!).response_format?.type)).toEqual(["json_schema", "json_object", "json_object"]);
  });

  it("maps gateway errors, malformed bodies and timeouts", async () => {
    const e401 = await new GxProvider({ fetch: mockFetch(() => jsonResponse({ error: "bad key gx-test-key" }, 401)) }).complete({ task: "triage", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(e401).toMatchObject({ code: "auth" });
    expect(e401.message).not.toContain("gx-test-key");
    const bad = await new GxProvider({ fetch: mockFetch(() => new Response("<html>oops</html>", { status: 200 })) }).complete({ task: "triage", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(bad).toMatchObject({ code: "bad_response" });
    const r = setEnv({ GX_TIMEOUT_MS: "30" });
    const hung = hangingFetch();
    const to = await new GxProvider({ fetch: hung }).complete({ task: "triage", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(to).toMatchObject({ code: "timeout" });
    r();
  });

  it("refuses web search and reports missing configuration", async () => {
    await expect(new GxProvider().complete({ task: "market_research", webSearch: true, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "unsupported" });
    expect(new GxProvider().supports("web_research")).toBe(false);
    expect(new GxProvider().supports("market_research")).toBe(true);
    const r = setEnv({ GX_API_KEY: undefined });
    const gx = new GxProvider();
    expect(gx.isConfigured()).toBe(false);
    await expect(gx.complete({ task: "triage", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "not_configured" });
    expect((await gx.health()).status).toBe("needs_configuration");
    r();
  });

  it("uses a tenant key when bound (withTenant) or via request context", async () => {
    const r = setEnv({ GX_API_KEY: undefined });
    setTenantSecretLookup(async (tenantId, provider, name) => (tenantId === "t1" && provider === "gx" && name === "GX_API_KEY" ? "tenant-gx-key" : undefined));
    expect(new GxProvider().isConfigured()).toBe(false);
    expect(await new GxProvider().isConfiguredFor("t1")).toBe(true);
    expect(await new GxProvider().isConfiguredFor("t2")).toBe(false);
    const f = mockFetch(() => completion("hello"));
    await new GxProvider({ fetch: f }).complete({ task: "summarise", messages: [{ role: "user", content: "x" }], context: { tenantId: "t1" } });
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer tenant-gx-key");
    const hf = mockFetch(() => jsonResponse({ data: [{ id: "gx-mini" }, { id: "gx-code" }] }));
    const h = await new GxProvider({ fetch: hf }).withTenant("t1").health();
    expect(h.status).toBe("connected");
    r();
  });

  it("health lists models (never gx-max) and flags missing ones", async () => {
    const f = mockFetch(() => jsonResponse({ data: [{ id: "gx-mini" }, { id: "gx-code" }, { id: "gx-auto" }, { id: "gx-max" }] }));
    const h = await new GxProvider({ fetch: f }).health();
    expect(h.status).toBe("connected");
    expect(h.meta?.models).toEqual(["gx-mini", "gx-code", "gx-auto"]);
    expect(JSON.stringify(h)).not.toContain("gx-test-key");
    const d = await new GxProvider({ fetch: mockFetch(() => jsonResponse({ data: [{ id: "gx-mini" }] })) }).health();
    expect(d.status).toBe("degraded");
    const e = await new GxProvider({ fetch: mockFetch(() => new Response("no", { status: 401 })) }).health();
    expect(e.status).toBe("error");
  });
});

// Opt-in live test against the local gateway: GX_LIVE_TEST=1 (needs GX_BASE_URL + GX_API_KEY in the environment).
const live = process.env.GX_LIVE_TEST === "1" ? describe : describe.skip;
live("GxProvider (live gateway)", () => {
  it("produces a valid OpportunityAnalysis with gx-code", { timeout: 300_000 }, async () => {
    restore();
    const gx = new GxProvider();
    const res = await gx.complete({
      task: "analyse_opportunity",
      schema: opportunityAnalysisSchema,
      messages: [
        {
          role: "user",
          content: opportunityAnalysisUserPrompt({ title: "3 UGC videos for a skincare serum", description: "Three 9:16 UGC-style videos, 15-20s each, hook in first 2s, captions, royalty-free music, 2 revisions, 7 days.", budgetType: "fixed", budgetMinUsd: 450, budgetMaxUsd: 450 }),
        },
      ],
    });
    expect(opportunityAnalysisSchema.safeParse(res.data).success).toBe(true);
    expect(res.usage.costSource).toBe("free");
    expect(res.data!.proposedWorkflow.length).toBeGreaterThan(0);
  });
});
