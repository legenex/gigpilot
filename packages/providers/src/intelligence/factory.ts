import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntelligenceProvider, IntelligenceRequest, IntelligenceResult, IntelligenceTask, ProviderHealth } from "@gigpilot/contracts";
import { inferenceCostUsd } from "@gigpilot/economics";
import { envValue, intEnv, setting } from "../lib/config";
import { credentialSource, resolveCredential } from "../lib/credentials";
import { ProviderError } from "../lib/errors";
import { redactText } from "../lib/http";
import { estimateTokens, jsonSchemaFor, messagesText, parseAndValidate, repairMessages } from "../lib/structured";
import type { IntelligenceMessage } from "@gigpilot/contracts";
import { normalizeStructured, schemaGuide, schemaNameFor, structuredSystemPrompt } from "./prompts";

/**
 * Factory.ai adapter — runs `droid exec` headless as a subprocess.
 *
 *  - execFile with an argv array (no shell). The prompt is written to a 0600
 *    file in a private temp dir and passed with `-f` (no ARG_MAX limits, not
 *    visible in `ps`). `--cwd` points at that empty temp dir.
 *  - Read-only autonomy (no `--auto`), `-o json`.
 *  - Model FACTORY_MODEL (default "auto" = Factory Router). `-m auto` is
 *    UNCERTAIN in the CLI docs: if the CLI rejects the model flag we retry
 *    once without `-m` and remember that for the process.
 *  - The child env is minimal (PATH/HOME/locale + FACTORY_API_KEY) — no other
 *    server secrets leak into the subprocess.
 *  - `-o json` reports no token usage → cost is estimated from prompt/result
 *    length at the catalog "auto" rate (costSource "catalog").
 *
 * Credentials (package-wide approach, see lib/credentials.ts): FACTORY_API_KEY
 * per call from the bound tenant (`withTenant`) or `req.context.tenantId`
 * (tenant secret) → env. `isConfigured()` = droid binary on PATH AND env key.
 */

export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };
export type ExecFn = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string; signal?: AbortSignal }) => Promise<ExecResult>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, killSignal: "SIGKILL", signal: opts.signal },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(err && err.killed && (err.signal === "SIGKILL" || err.signal === "SIGTERM"));
        let code: number | null = 0;
        if (err) code = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code, timedOut });
      },
    );
  });

/** PATH lookup without executing anything (and without spending money). */
export function whichBinary(bin: string, envPath = process.env.PATH ?? ""): string | null {
  const isExec = (p: string) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) return isExec(bin) ? bin : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExec(candidate)) return candidate;
  }
  return null;
}

let omitModelFlag = false;
const whichCache = new Map<string, { value: string | null; expires: number }>();

export interface FactoryOptions {
  tenantId?: string | null;
  exec?: ExecFn;
  which?: (bin: string) => string | null;
}

interface DroidResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  session_id?: string;
}

const DEFAULT_OUTPUT_TOKENS = 2000;

export class FactoryProvider implements IntelligenceProvider {
  readonly family = "factory" as const;
  readonly paid = true;

  constructor(private readonly opts: FactoryOptions = {}) {}

  withTenant(tenantId: string | null): FactoryProvider {
    return new FactoryProvider({ ...this.opts, tenantId });
  }

  private binName(): string {
    return setting("FACTORY_DROID_BIN") || "droid";
  }

  /** Resolved droid path (cached ≤ 60 s), null when not installed. */
  resolveBinary(): string | null {
    const bin = this.binName();
    if (this.opts.which) return this.opts.which(bin);
    const hit = whichCache.get(bin);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = whichBinary(bin);
    whichCache.set(bin, { value, expires: Date.now() + 60_000 });
    return value;
  }

  isConfigured(): boolean {
    return Boolean(this.resolveBinary() && envValue("FACTORY_API_KEY"));
  }

  /** Tenant-aware configuration check (tenant secret → env; binary on PATH). */
  async isConfiguredFor(tenantId: string | null): Promise<boolean> {
    return Boolean(this.resolveBinary() && (await resolveCredential("factory", "FACTORY_API_KEY", tenantId ?? this.opts.tenantId ?? null)));
  }

  supports(task: IntelligenceTask): boolean {
    // No provider-native web search in read-only droid exec.
    return task !== "web_research";
  }

  private model(): string {
    return setting("FACTORY_MODEL") || "auto";
  }

  estimateCost(req: IntelligenceRequest): number {
    const inTok = estimateTokens(messagesText(req.messages)) + (req.schema ? estimateTokens(JSON.stringify(jsonSchemaFor(req.schema))) + 600 : 0);
    const outTok = req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const one = inferenceCostUsd("factory", this.model(), inTok, outTok) ?? 0;
    // Structured requests may need one repair round-trip.
    return req.schema ? one * 2 : one;
  }

  async complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>> {
    const started = Date.now();
    if (req.webSearch) throw new ProviderError("factory", "unsupported", "droid exec runs read-only without web search; route web research to Grok");
    const bin = this.resolveBinary();
    const tenantId = this.opts.tenantId ?? req.context?.tenantId ?? null;
    const key = await resolveCredential("factory", "FACTORY_API_KEY", tenantId);
    if (!bin || !key) {
      throw new ProviderError("factory", "not_configured", !bin ? `droid CLI not found on PATH (FACTORY_DROID_BIN=${this.binName()})` : "FACTORY_API_KEY is not set");
    }
    const estimate = this.estimateCost(req);
    if (req.maxCostUsd !== undefined && estimate > req.maxCostUsd) {
      throw new ProviderError("factory", "budget_exceeded", `estimated $${estimate.toFixed(4)} exceeds the call limit $${req.maxCostUsd.toFixed(4)}`);
    }

    const schemaName = schemaNameFor(req.schema, req.schemaName);
    const extraSystem = req.schema ? structuredSystemPrompt(schemaName, jsonSchemaFor(req.schema), schemaGuide(req.schema, req.schemaName)) : undefined;
    let messages: IntelligenceMessage[] = req.messages;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const attempts = req.schema ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const prompt = renderPrompt(messages, extraSystem);
      const text = await this.run(bin, key, prompt, req.signal);
      const inTok = estimateTokens(prompt);
      const outTok = estimateTokens(text);
      inputTokens += inTok;
      outputTokens += outTok;
      costUsd += inferenceCostUsd("factory", this.model(), inTok, outTok) ?? 0;
      if (!req.schema) {
        return { family: "factory", model: this.model(), text, usage: { inputTokens, outputTokens, costUsd, costSource: "catalog" }, latencyMs: Date.now() - started };
      }
      const outcome = parseAndValidate(req.schema, text, (v) => normalizeStructured(req.schema, v));
      if (outcome.ok) {
        return { family: "factory", model: this.model(), text, data: outcome.data, usage: { inputTokens, outputTokens, costUsd, costSource: "catalog" }, latencyMs: Date.now() - started };
      }
      if (attempt + 1 < attempts) {
        if (req.maxCostUsd !== undefined && costUsd * 2 > req.maxCostUsd) {
          throw new ProviderError("factory", "structured_output", `output failed ${schemaName} validation and a repair would exceed the call limit: ${outcome.issues.slice(0, 5).join("; ")}`, {
            meta: { inputTokens, outputTokens, costUsd },
          });
        }
        messages = repairMessages(messages, text, outcome.issues, schemaName);
      } else {
        throw new ProviderError("factory", "structured_output", `output failed ${schemaName} validation after one repair: ${outcome.issues.slice(0, 5).join("; ")}`, {
          meta: { inputTokens, outputTokens, costUsd },
        });
      }
    }
    throw new ProviderError("factory", "structured_output", "unreachable");
  }

  private childEnv(key: string): NodeJS.ProcessEnv {
    const env: Record<string, string> = { FACTORY_API_KEY: key, NO_COLOR: "1", CI: "1" };
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      const v = process.env[name];
      if (v) env[name] = v;
    }
    // Minimal child env (no inherited secrets); cast because Next augments ProcessEnv with NODE_ENV.
    return env as unknown as NodeJS.ProcessEnv;
  }

  private async run(bin: string, key: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const exec = this.opts.exec ?? defaultExec;
    const timeoutMs = intEnv("FACTORY_TIMEOUT_MS", 300_000, 5_000, 3_600_000);
    const dir = await mkdtemp(path.join(tmpdir(), "gigpilot-droid-"));
    try {
      const promptFile = path.join(dir, "prompt.md");
      await writeFile(promptFile, prompt, { mode: 0o600 });
      const model = this.model();
      const argsFor = (withModel: boolean) => ["exec", "-o", "json", "--cwd", dir, ...(withModel ? ["-m", model] : []), "-f", promptFile];
      let useModel = !omitModelFlag && Boolean(model);
      let res = await exec(bin, argsFor(useModel), { env: this.childEnv(key), timeoutMs, cwd: dir, signal });
      if (res.code !== 0 && useModel && !res.timedOut && /model|-m\b|--model|unknown option|invalid/i.test(res.stderr + res.stdout) && !/auth|api key|unauthori[sz]ed|401/i.test(res.stderr + res.stdout)) {
        // UNCERTAIN: `-m auto` may be rejected by the CLI → Factory default model routing.
        omitModelFlag = true;
        useModel = false;
        res = await exec(bin, argsFor(false), { env: this.childEnv(key), timeoutMs, cwd: dir, signal });
      }
      return this.parseResult(res, key);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private parseResult(res: ExecResult, key: string): string {
    const scrub = (s: string) => redactText(s, [key]).replace(/\s+/g, " ").trim().slice(0, 300);
    if (res.timedOut) throw new ProviderError("factory", "timeout", "droid exec timed out");
    const parsed = parseDroidJson(res.stdout);
    if (!parsed) {
      if (res.code === 127) throw new ProviderError("factory", "not_configured", "droid CLI could not be executed");
      const detail = scrub(res.stderr || res.stdout) || `exit code ${res.code}`;
      if (/auth|api key|unauthori[sz]ed|401|forbidden/i.test(detail)) throw new ProviderError("factory", "auth", `droid rejected the credentials: ${detail}`);
      throw new ProviderError("factory", res.code === 0 ? "bad_response" : "provider_error", `droid exec produced no JSON result: ${detail}`);
    }
    if (parsed.is_error || parsed.subtype === "error" || typeof parsed.result !== "string") {
      const detail = scrub(typeof parsed.result === "string" ? parsed.result : res.stderr) || "unknown error";
      if (/auth|api key|unauthori[sz]ed|401/i.test(detail)) throw new ProviderError("factory", "auth", `droid rejected the credentials: ${detail}`);
      if (/credit|quota|billing|limit/i.test(detail)) throw new ProviderError("factory", "insufficient_credits", `droid reported: ${detail}`);
      throw new ProviderError("factory", "provider_error", `droid reported an error: ${detail}`);
    }
    return parsed.result;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const bin = this.resolveBinary();
    const key = await resolveCredential("factory", "FACTORY_API_KEY", this.opts.tenantId ?? null);
    const problems: string[] = [];
    if (!bin) problems.push(`droid CLI not installed or not on PATH (FACTORY_DROID_BIN=${this.binName()}; install: npm i -g droid)`);
    if (!key) problems.push("FACTORY_API_KEY is not set (create one at app.factory.ai/settings/api-keys)");
    if (!bin) return { status: "needs_configuration", detail: problems.join("; "), checkedAt, meta: { binaryFound: false, keyPresent: Boolean(key) } };
    const started = Date.now();
    const exec = this.opts.exec ?? defaultExec;
    const res = await exec(bin, ["--version"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv, timeoutMs: 10_000 });
    const latencyMs = Date.now() - started;
    const version = (res.stdout || res.stderr).trim().split("\n")[0]?.slice(0, 80);
    if (res.code !== 0) return { status: "error", detail: `droid --version failed (exit ${res.code}).`, latencyMs, checkedAt };
    if (!key) return { status: "needs_configuration", detail: problems.join("; "), latencyMs, checkedAt, meta: { binaryFound: true, version, keyPresent: false } };
    return {
      status: "connected",
      detail: `droid ${version ?? ""} installed; API key present (not validated — validating would need a billed call).`.replace(/\s+/g, " "),
      latencyMs,
      checkedAt,
      meta: { binaryFound: true, version, keyPresent: true, keySource: credentialSource("FACTORY_API_KEY", key), model: this.model(), modelFlag: omitModelFlag ? "omitted" : "sent" },
    };
  }
}

/** Flatten chat messages into one prompt for `droid exec`. */
export function renderPrompt(messages: IntelligenceMessage[], extraSystem?: string): string {
  const system = [...messages.filter((m) => m.role === "system").map((m) => m.content.trim()), extraSystem?.trim()].filter(Boolean).join("\n\n");
  const convo = messages.filter((m) => m.role !== "system");
  const parts: string[] = [];
  if (system) parts.push(`# Instructions\n\n${system}`);
  parts.push("# Constraints\n\nAnswer directly from the information below. Do not read, create or modify files and do not run commands.");
  if (convo.length === 1 && convo[0]!.role === "user") parts.push(`# Task\n\n${convo[0]!.content}`);
  else if (convo.length) parts.push(`# Conversation\n\n${convo.map((m) => `## ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content}`).join("\n\n")}\n\nRespond to the last user message.`);
  return parts.join("\n\n");
}

/** Find the `{"type":"result",...}` object in droid's stdout (tolerates log lines). */
export function parseDroidJson(stdout: string): DroidResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, ...trimmed.split("\n").reverse()];
  for (const c of candidates) {
    const s = c.trim();
    if (!s.startsWith("{")) continue;
    try {
      const obj = JSON.parse(s) as DroidResult;
      if (obj && typeof obj === "object" && (obj.type === "result" || "result" in obj)) return obj;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Test helper. */
export function resetFactoryState(): void {
  omitModelFlag = false;
  whichCache.clear();
}
