import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLEAR_PROVIDER_ENV, setEnv } from "../lib/testing";
import { FactoryProvider, parseDroidJson, renderPrompt, resetFactoryState, type ExecFn, type ExecResult } from "./factory";

// Low-entropy fake credential built at runtime (keeps secret scanners quiet).
const FAKE_KEY = ["fk", "x".repeat(12)].join("-");

const ok = (result: string): ExecResult => ({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 1, result, session_id: "s1" }), stderr: "", code: 0, timedOut: false });

function recorder(respond: (args: string[], call: number) => ExecResult | Promise<ExecResult>) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv; prompt?: string }[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const fIdx = args.indexOf("-f");
    const prompt = fIdx >= 0 ? readFileSync(args[fIdx + 1]!, "utf8") : undefined;
    calls.push({ file, args, env: opts.env, prompt });
    return respond(args, calls.length);
  };
  return { exec, calls };
}

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ ...CLEAR_PROVIDER_ENV, FACTORY_API_KEY: FAKE_KEY, SOME_OTHER_SECRET: "do-not-leak", FACTORY_ALLOW_IN_PROCESS: "true" });
  resetFactoryState();
});
afterEach(() => restore());

const which = () => "/usr/local/bin/droid";

describe("FactoryProvider", () => {
  it("stays needs_configuration (sandbox required) unless FACTORY_ALLOW_IN_PROCESS=true", async () => {
    const undo = setEnv({ FACTORY_ALLOW_IN_PROCESS: undefined });
    try {
      const { exec, calls } = recorder(() => ok("never"));
      const p = new FactoryProvider({ exec, which });
      expect(p.isConfigured()).toBe(false);
      expect(await p.isConfiguredFor(null)).toBe(false);
      const h = await p.health();
      expect(h.status).toBe("needs_configuration");
      expect(h.detail).toMatch(/requires an isolated sandbox runner/);
      await expect(p.complete({ task: "proposal", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "not_configured" });
      expect(calls).toHaveLength(0);
    } finally {
      undo();
    }
  });

  it("runs droid exec read-only with -o json, -m auto, --cwd and a prompt file; minimal child env", async () => {
    const { exec, calls } = recorder(() => ok("Hello from droid"));
    const res = await new FactoryProvider({ exec, which }).complete({ task: "proposal", messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Draft it." }] });
    expect(res.text).toBe("Hello from droid");
    expect(res.family).toBe("factory");
    expect(res.usage.costSource).toBe("catalog");
    expect(res.usage.costUsd).toBeGreaterThan(0);
    const c = calls[0]!;
    expect(c.file).toBe("/usr/local/bin/droid");
    expect(c.args.slice(0, 3)).toEqual(["exec", "-o", "json"]);
    expect(c.args).toContain("--cwd");
    expect(c.args.join(" ")).toContain("-m auto");
    expect(c.args).not.toContain("--auto");
    expect(c.args).not.toContain("--skip-permissions-unsafe");
    expect(c.prompt).toContain("Be concise.");
    expect(c.prompt).toContain("Draft it.");
    expect(c.env.FACTORY_API_KEY).toBe(FAKE_KEY);
    expect(c.env.SOME_OTHER_SECRET).toBeUndefined();
    expect(Object.keys(c.env).every((k) => ["FACTORY_API_KEY", "NO_COLOR", "CI", "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"].includes(k))).toBe(true);
  });

  it("retries once without -m when the CLI rejects the model flag, then remembers", async () => {
    const { exec, calls } = recorder((args) => (args.includes("-m") ? { stdout: "", stderr: "error: invalid model 'auto'", code: 1, timedOut: false } : ok("fine")));
    const p = new FactoryProvider({ exec, which });
    expect((await p.complete({ task: "summarise", messages: [{ role: "user", content: "x" }] })).text).toBe("fine");
    await p.complete({ task: "summarise", messages: [{ role: "user", content: "y" }] });
    expect(calls.map((c) => c.args.includes("-m"))).toEqual([true, false, false]);
  });

  it("validates structured output with one repair", async () => {
    const schema = z.object({ verdict: z.enum(["pass", "fail"]) });
    const { exec, calls } = recorder((_a, n) => ok(n === 1 ? '{"verdict":"maybe"}' : '```json\n{"verdict":"pass"}\n```'));
    const res = await new FactoryProvider({ exec, which }).complete({ task: "qa_high", schema, messages: [{ role: "user", content: "judge" }] });
    expect(res.data).toEqual({ verdict: "pass" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("did not match");
  });

  it("maps is_error, auth failures, garbage output and timeouts", async () => {
    const run = (r: ExecResult) => new FactoryProvider({ exec: async () => r, which }).complete({ task: "code", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(await run({ stdout: JSON.stringify({ type: "result", is_error: true, result: `Unauthorized: invalid API key ${FAKE_KEY}` }), stderr: "", code: 1, timedOut: false })).toMatchObject({ code: "auth" });
    const e = await run({ stdout: JSON.stringify({ type: "result", is_error: true, result: "tool error" }), stderr: "", code: 1, timedOut: false });
    expect(e).toMatchObject({ code: "provider_error" });
    const g = await run({ stdout: "not json", stderr: `boom with ${FAKE_KEY}`, code: 2, timedOut: false });
    expect(g.code).toBe("provider_error");
    expect(g.message).not.toContain(FAKE_KEY);
    expect(await run({ stdout: "", stderr: "", code: null, timedOut: true })).toMatchObject({ code: "timeout" });
  });

  it("refuses when the estimate exceeds maxCostUsd and when not configured", async () => {
    const { exec, calls } = recorder(() => ok("x"));
    await expect(new FactoryProvider({ exec, which }).complete({ task: "code", maxCostUsd: 0.000001, messages: [{ role: "user", content: "x".repeat(4000) }] })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(calls).toHaveLength(0);
    await expect(new FactoryProvider({ exec, which: () => null }).complete({ task: "code", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "not_configured" });
    const r = setEnv({ FACTORY_API_KEY: undefined });
    expect(new FactoryProvider({ exec, which }).isConfigured()).toBe(false);
    r();
  });

  it("health: needs_configuration with precise detail; connected via droid --version only", async () => {
    const missing = await new FactoryProvider({ which: () => null }).health();
    expect(missing.status).toBe("needs_configuration");
    expect(missing.detail).toMatch(/droid CLI not installed/);
    const { exec, calls } = recorder(() => ({ stdout: "droid 1.9.0\n", stderr: "", code: 0, timedOut: false }));
    const h = await new FactoryProvider({ exec, which }).health();
    expect(h.status).toBe("connected");
    expect(calls[0]!.args).toEqual(["--version"]);
    expect(JSON.stringify(h)).not.toContain(FAKE_KEY);
    const r = setEnv({ FACTORY_API_KEY: undefined });
    const nk = await new FactoryProvider({ exec, which }).health();
    expect(nk.status).toBe("needs_configuration");
    expect(nk.detail).toMatch(/FACTORY_API_KEY/);
    r();
  });

  it("parses droid JSON amid log lines and renders prompts", () => {
    expect(parseDroidJson('warn: something\n{"type":"result","result":"ok","is_error":false}\n')?.result).toBe("ok");
    expect(parseDroidJson("")).toBeNull();
    const p = renderPrompt([{ role: "system", content: "S" }, { role: "user", content: "U1" }, { role: "assistant", content: "A1" }, { role: "user", content: "U2" }]);
    expect(p).toMatch(/# Instructions[\s\S]*S[\s\S]*## User[\s\S]*U1[\s\S]*## Assistant[\s\S]*A1/);
  });
});
