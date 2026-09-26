import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { AGENTS, InvalidTransitionError, QUEUES, type AgentKey, type Capability, type CreativeRequest, type IntelligenceTask, type QueuePayloads } from "@gigpilot/contracts";
import { and, asset, client, ConcurrentTransitionError, desc, emitEvent, eq, getDb, inArray, job, opportunityAnalysis, transition, workflowStep, type TransitionInput } from "@gigpilot/db";
import { isProviderError, neutraliseDelimiters, wrapUntrusted } from "@gigpilot/providers";
import { storageOf, type AgentDeps } from "../deps";
import { codeArtifactSchema, generateAutomationArtifact, generateWebArtifact, scaffoldRequestedFeatures, type CodeArtifact } from "../heuristics/code";
import { buildConcepts, buildSrt, generateDocument, langCode, productPhrase, type Concept, type ContentContext } from "../heuristics/content";
import { isQaStep } from "../heuristics/workflows";
import { notify } from "../lib/notify";
export { OWNER_BLOCK_REASONS, blockedReasonOf, isOwnerBlocked, type OwnerBlockReason } from "../lib/steps";
import { money, quote, safeError, slugify, truncate } from "../lib/util";
import {
  abortReasonOf,
  BudgetBlockedError,
  callCreative,
  callIntelligence,
  runAgent,
  StepAbortedError,
  storeFile,
  type AssetRow,
  type JobRow,
  type RunContext,
  type StepRow,
} from "../runtime";
import { loadActiveSteps } from "./orchestrator";
import { runQaStep } from "./qa";
import { recoverFromQaFailure } from "./recovery";

export interface StepOutcome {
  output: Record<string, unknown>;
  summary: string;
  verdict?: "pass" | "fail";
}

export interface RepairDirective {
  repairId: string;
  strategy: "repair" | "regenerate" | "reroute";
  hint: string;
  unitIndexes?: number[];
  generationIds?: string[];
  exclude?: { provider: string; model: string }[];
  avoidFamilies?: string[];
  /** Duplicate units: render a different concept variant (shift applied to the unit's variant index). */
  variantShift?: number;
  /** The QA failure being repaired was a simulated defect injected for the demo. */
  demoDefect?: boolean;
}

/** Unit concept + copy variant for a GLOBAL unit index (unique across all batches of a job). */
export function unitCreative(concepts: Concept[], globalIndex: number): { concept: Concept; headline: string; subhead: string; scene: string; variant: number } {
  const list = concepts.length ? concepts : [{ angle: "Hero", headline: "Hero", subhead: "", cta: "Learn more", scene: "Product hero", script: [] }];
  const n = list.length;
  const c = list[((globalIndex % n) + n) % n]!;
  const v = Math.floor(globalIndex / n);
  if (v <= 0) return { concept: c, headline: c.headline, subhead: c.subhead, scene: c.scene, variant: 0 };
  // Later units re-use the angle with a different hook line and scene (never an identical render).
  const beats = c.script.map((b) => b.trim()).filter((b) => b.length >= 3);
  const alt = beats.length ? beats[(v - 1) % beats.length]! : null;
  return {
    concept: c,
    headline: alt ? alt.replace(/[.…!]+$/, "") : `${c.headline} (${c.angle} take ${v + 1})`,
    subhead: v % 2 === 1 ? c.subhead : `${c.angle}: ${c.subhead}`,
    scene: `${c.scene}, alternate take ${["two", "three", "four", "five", "six", "seven", "eight"][(v - 1) % 7]}`,
    variant: v,
  };
}

const conceptSchema = z.object({
  angle: z.string(),
  headline: z.string().min(2),
  subhead: z.string(),
  cta: z.string(),
  scene: z.string(),
  script: z.array(z.string()).default([]),
});
const documentSchema = z.object({ markdown: z.string().min(80), concepts: z.array(conceptSchema).optional() });

function agentKey(agent: string): AgentKey {
  return (agent in AGENTS ? agent : "orchestrator") as AgentKey;
}

function inputOf(step: StepRow): Record<string, unknown> {
  return (step.input ?? {}) as Record<string, unknown>;
}

function outputOf(step: StepRow | undefined): Record<string, unknown> {
  return ((step?.output ?? {}) as Record<string, unknown>) ?? {};
}

export function repairOf(step: StepRow): RepairDirective | null {
  const r = inputOf(step).repair as RepairDirective | undefined;
  return r && typeof r === "object" && r.repairId ? r : null;
}

/** The demo defect applies only on the very first attempt of the chosen step. */
export function activeDefect(step: StepRow, attempt: number): string | null {
  const d = inputOf(step).simulateDefect;
  return typeof d === "string" && attempt === 1 && !repairOf(step) ? d : null;
}

async function latestAnalysis(j: JobRow) {
  if (!j.opportunityId) return null;
  const [row] = await getDb()
    .select({ analysis: opportunityAnalysis.analysis })
    .from(opportunityAnalysis)
    .where(eq(opportunityAnalysis.opportunityId, j.opportunityId))
    .orderBy(desc(opportunityAnalysis.version))
    .limit(1);
  return row?.analysis ?? null;
}

export async function clientNameOf(j: JobRow): Promise<string | null> {
  if (!j.clientId) return null;
  const [c] = await getDb().select({ name: client.name }).from(client).where(eq(client.id, j.clientId)).limit(1);
  return c?.name ?? null;
}

function upstreamKeys(step: StepRow, all: StepRow[]): Set<string> {
  const byKey = new Map(all.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const walk = (k: string) => {
    for (const d of byKey.get(k)?.dependsOn ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        walk(d);
      }
    }
  };
  walk(step.key);
  return seen;
}

async function contentContext(ctx: RunContext, j: JobRow, step: StepRow, all: StepRow[], attempt: number): Promise<ContentContext> {
  const analysis = await latestAnalysis(j);
  const upstream = upstreamKeys(step, all);
  const prior: Record<string, string> = {};
  for (const s of all) if (upstream.has(s.key) && typeof outputOf(s).markdown === "string") prior[s.key] = outputOf(s).markdown as string;
  const input = inputOf(step);
  return {
    title: j.title,
    brief: j.brief,
    clientName: await clientNameOf(j),
    family: j.serviceFamily,
    analysis,
    acceptance: [...step.acceptance, ...j.acceptanceCriteria].slice(0, 12),
    stepKey: step.key,
    stepName: step.name,
    stepKind: step.kind,
    prior,
    defect: activeDefect(step, attempt),
    repairHint: repairOf(step)?.hint ?? null,
    revisionNote: typeof input.revisionNote === "string" ? input.revisionNote : null,
    languages: Array.isArray(input.languages) ? (input.languages as string[]) : undefined,
  };
}

const DOC_TASK: Record<string, IntelligenceTask> = {
  brief: "summarise",
  research: "web_research",
  concepts: "plan_production",
  copy: "plan_production",
  assemble: "summarise",
  finalize: "summarise",
};

function docMessages(c: ContentContext, fallback: string) {
  return [
    {
      role: "system" as const,
      content:
        `You are GigPilot's ${c.stepName} worker. Produce the deliverable as Markdown in JSON {"markdown": "..."}` +
        (c.stepKind === "concepts" && (c.family === "paid-social-ugc" || c.family === "image-design")
          ? ' plus "concepts": [{angle, headline, subhead, cta, scene, script[]}] (4 concepts).'
          : ".") +
        " Be specific to the brief; never invent statistics or client facts. Use '## ' section headings.",
    },
    {
      role: "user" as const,
      content: [
        wrapUntrusted("client brief", [`Job: ${c.title}`, `Brief: ${truncate(c.brief, 1500)}`, `Acceptance criteria: ${c.acceptance.join("; ")}`].join("\n")),
        c.repairHint ? `QA feedback to fix: ${neutraliseDelimiters(c.repairHint)}` : "",
        c.revisionNote ? `Owner revision request: ${neutraliseDelimiters(c.revisionNote)}` : "",
        Object.keys(c.prior).length ? `Upstream notes (earlier outputs):\n${wrapUntrusted("upstream outputs", Object.entries(c.prior).map(([k, v]) => `### ${k}\n${truncate(v, 1200)}`).join("\n"))}` : "",
        `Required structure example:\n${wrapUntrusted("structure example", truncate(fallback, 1200))}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

/** Remove ad-creative concept blocks (Concept sections, Headline/CTA/Scene lines) from non-creative docs. */
export function stripCreativeConcepts(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^#{1,3}\s/.test(l)) skipping = /^#{1,3}\s*(concepts?\b|concept \d|hooks? & scripts|hook bank)/i.test(l.trim());
    if (skipping) continue;
    if (/^\s*[-*]?\s*\*{0,2}(headline|subhead|cta|scene|script beats)\*{0,2}\s*:/i.test(l)) continue;
    out.push(l);
  }
  return out.join("\n");
}

function stripSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (l.startsWith("## ")) skipping = l.trim().toLowerCase() === heading.toLowerCase();
    if (!skipping) out.push(l);
  }
  return out.join("\n");
}

async function executeDocument(ctx: RunContext, j: JobRow, step: StepRow, all: StepRow[], attempt: number, extra: { assetNames?: string[] } = {}): Promise<StepOutcome> {
  const c = await contentContext(ctx, j, step, all, attempt);
  const generated = generateDocument(c, extra);
  const res = await callIntelligence(ctx, {
    task: DOC_TASK[step.kind] ?? "summarise",
    schema: documentSchema,
    schemaName: `${step.kind}_document`,
    webSearch: step.kind === "research",
    maxOutputTokens: 2200,
    messages: docMessages(c, generated.markdown),
    mockResult: () => generated,
  });
  let markdown = res.data?.markdown ?? generated.markdown;
  if (c.defect === "missing_section") markdown = stripSection(markdown, "## Sources");
  // Per-family templates only: ad-creative concept blocks never leak into non-creative deliverables.
  if (j.serviceFamily !== "paid-social-ugc" && j.serviceFamily !== "image-design") markdown = stripCreativeConcepts(markdown);
  const noWeb = res.webResearch?.requested === true && !res.webResearch.performed;
  if (noWeb && !/no live web research/i.test(markdown)) {
    const lines = markdown.split("\n");
    const at = lines[0]?.startsWith("# ") ? 1 : 0;
    lines.splice(at, 0, "", `> ${res.webResearch?.note ?? "No live web research (model knowledge only)"} — findings are not backed by current web sources.`);
    markdown = lines.join("\n");
  }
  const concepts: Concept[] | undefined =
    step.kind === "concepts" && (j.serviceFamily === "paid-social-ugc" || j.serviceFamily === "image-design")
      ? res.data?.concepts?.length
        ? res.data.concepts
        : (generated.concepts ?? buildConcepts(c))
      : undefined;
  const db = getDb();
  const file = await storeFile(ctx.deps, db, {
    tenantId: j.tenantId,
    jobId: j.id,
    stepId: step.id,
    filename: `${step.key}-${slugify(step.name, 32)}.md`,
    mime: "text/markdown",
    bytes: strToU8(markdown),
    kind: "document",
    meta: { stepKey: step.key, attempt, provider: res.family, model: res.model },
  });
  const firstLine = markdown.split("\n").find((l) => l.startsWith("- ") || (l.length > 40 && !l.startsWith("#") && !l.startsWith(">")));
  return {
    output: {
      markdown: markdown.slice(0, 20_000),
      concepts,
      assets: [{ assetId: file.id, filename: file.filename, kind: file.kind }],
      provider: res.family,
      model: res.model,
      ...(res.webResearch ? { webResearch: res.webResearch.performed ? "live" : "none" } : {}),
    },
    summary: `${step.name} drafted (${res.family === "mock" ? "deterministic mock" : `${res.family}/${res.model}`}${noWeb ? ", no live web research" : ""})${firstLine ? ` — ${truncate(firstLine.replace(/^- /, ""), 90)}` : ""}`,
  };
}

function conceptsFor(all: StepRow[], j: JobRow, clientName: string | null): Concept[] {
  const cstep = all.find((s) => s.kind === "concepts" && Array.isArray(outputOf(s).concepts));
  const list = (cstep ? (outputOf(cstep).concepts as Concept[]) : []).filter((c) => c && typeof c.headline === "string");
  return list.length ? list : buildConcepts({ title: j.title, clientName, analysis: null });
}

interface GenItem {
  unitIndex: number;
  /** Unit index across all batches of the job (planner offset + unitIndex). */
  globalIndex?: number;
  generationId: string;
  assetIds: string[];
  filenames: string[];
  provider: string;
  model: string;
  concept: string;
  mode: string;
}

async function executeGenerate(ctx: RunContext, j: JobRow, step: StepRow, all: StepRow[], attempt: number): Promise<StepOutcome> {
  const input = inputOf(step);
  const units = Math.max(1, Number(input.units ?? 4));
  const aspectRatio = (typeof input.aspectRatio === "string" ? input.aspectRatio : undefined) as CreativeRequest["aspectRatio"];
  const durationSec = typeof input.durationSec === "number" ? input.durationSec : step.capability?.startsWith("video.") ? 15 : undefined;
  const capability = (step.capability ?? "image.generate") as Capability;
  const clientName = await clientNameOf(j);
  const concepts = conceptsFor(all, j, clientName);
  const repair = repairOf(step);
  const previous = (Array.isArray(outputOf(step).items) ? (outputOf(step).items as GenItem[]) : []).filter((i) => typeof i.unitIndex === "number");
  const toRender = repair?.unitIndexes?.length ? repair.unitIndexes : Array.from({ length: units }, (_, i) => i);
  const defect = activeDefect(step, attempt);
  const items = new Map<number, GenItem>(repair ? previous.map((p) => [p.unitIndex, p]) : []);
  // Unit keys are scoped to the repair/revision that asked for them, never to the attempt:
  // units that already succeeded are reused on a retry instead of regenerated (and re-paid).
  const scope = repair?.repairId ?? (typeof input.revisionRepairId === "string" ? `rev-${input.revisionRepairId}` : "base");
  // Global unit offset (planner): batch B continues after batch A, so no two units share a concept variant.
  const unitOffset = Math.max(0, Number(input.unitOffset ?? 0) || 0);
  const shift = repair?.variantShift ?? 0;
  let spent = 0;
  let mode = "live";
  for (const i of toRender) {
    await ctx.checkpoint();
    const globalIndex = unitOffset + i;
    const u = unitCreative(concepts, globalIndex + (repair?.unitIndexes?.includes(i) ? shift * 7 : 0));
    const c = u.concept;
    const prompt = [
      `Headline: ${u.headline}`,
      `Subhead: ${u.subhead}`,
      `CTA: ${c.cta}`,
      `Brand: ${clientName ?? productPhrase(j.title)}`,
      `Scene: ${u.scene}`,
      `Script: ${c.script.join(" | ")}`,
      `Format: ${aspectRatio ?? "as briefed"}${durationSec && capability.startsWith("video.") ? `, ${durationSec}s` : ""}`,
      "Style: premium, high-contrast, mobile-first; keep logo and text inside the safe zone.",
      repair?.hint ? `Fix: ${repair.hint}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const useEdit = repair?.strategy === "repair" && capability === "image.generate";
    const prev = items.get(i);
    const res = await callCreative(ctx, {
      job: j,
      step,
      capability: useEdit ? "image.edit" : capability,
      prompt,
      aspectRatio,
      durationSec: capability.startsWith("video.") ? durationSec : undefined,
      params: { unitIndex: i, globalIndex, variant: globalIndex, conceptVariant: u.variant, concept: c.angle },
      idempotencyKey: `gen:${step.id}:${scope}:${i}`,
      label: `${step.name.replace(/ — batch [A-Z]$/, "")} #${globalIndex + 1}${useEdit ? " (edit)" : ""}`,
      simulateDefect: defect && i === toRender[0] ? defect : null,
      exclude: repair?.exclude,
      repairOfId: repair ? (prev?.generationId ?? null) : null,
    });
    if (!res.reused) spent += res.costUsd;
    mode = res.mode;
    items.set(i, {
      unitIndex: i,
      generationId: res.generationId,
      assetIds: res.assets.map((a) => a.id),
      filenames: res.assets.map((a) => a.filename),
      provider: res.provider,
      model: res.model,
      concept: c.angle,
      mode: res.mode,
      globalIndex,
    });
  }
  const sorted = [...items.values()].sort((a, b) => a.unitIndex - b.unitIndex);
  const noun = capability.startsWith("video.") ? (mode === "mock" ? "storyboards" : "videos") : "creatives";
  return {
    output: {
      items: sorted,
      capability,
      aspectRatio: aspectRatio ?? null,
      durationSec: durationSec ?? null,
      units,
      deliverableUnits: Number(input.deliverableUnits ?? units),
      unitOffset,
      assets: sorted.flatMap((s) => s.assetIds.map((id, k) => ({ assetId: id, filename: s.filenames[k], kind: "image" }))),
    },
    summary: `${repair ? `Re-rendered ${toRender.length} of ${units}` : `Rendered ${units}`} ${aspectRatio ?? ""} ${noun}${mode === "mock" ? " in mock mode" : ""} · ${money(spent)}${mode === "mock" ? " simulated" : ""}`.replace(/\s+/g, " "),
  };
}

/**
 * Archive entry path for a model-supplied file path, or null when unsafe
 * (absolute, drive-letter, `..` traversal, NUL, empty). Normalised with
 * path.posix so `a/./b` and `a//b` collapse; never rewritten into something
 * else — unsafe entries are rejected, not "cleaned".
 */
export function safeArchivePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("~")) return null;
  if (p.split("/").some((seg) => seg === "..")) return null;
  const norm = path.posix.normalize(p).replace(/^(\.\/)+/, "");
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm) || norm.endsWith("/")) return null;
  return norm;
}

export function zipArtifact(art: CodeArtifact): { bytes: Uint8Array; rejected: string[] } {
  const files: Record<string, Uint8Array> = {};
  const rejected: string[] = [];
  for (const f of art.files) {
    const safe = safeArchivePath(f.path);
    if (!safe || safe === "test-report.json") {
      rejected.push(String(f.path).slice(0, 200));
      continue;
    }
    files[`project/${safe}`] = strToU8(f.content);
  }
  files["project/test-report.json"] = strToU8(JSON.stringify(art.testReport, null, 2));
  return { bytes: zipSync(files, { level: 6 }), rejected };
}

async function executeCode(ctx: RunContext, j: JobRow, step: StepRow, _all: StepRow[], attempt: number): Promise<StepOutcome> {
  const repair = repairOf(step);
  const defect = activeDefect(step, attempt);
  const clientName = await clientNameOf(j);
  // Feature coverage must be judged against the SAME text QA uses, so the deterministic
  // generator attempts every feature the client asked for (client request + analysis).
  const analysis = await latestAnalysis(j);
  const codeBrief = [j.title, analysis?.clientRequest ?? "", j.brief, ...(analysis?.requestedFeatures ?? [])].filter(Boolean).join("\n");
  const deterministic =
    j.serviceFamily === "web-app-builds"
      ? generateWebArtifact({ title: j.title, brief: codeBrief, clientName, defect, repairHint: repair?.hint ?? null })
      : generateAutomationArtifact({ title: j.title, brief: codeBrief, defect, repairHint: repair?.hint ?? null });
  const res = await callIntelligence(
    ctx,
    {
      task: "code",
      schema: codeArtifactSchema,
      schemaName: "code_artifact",
      maxOutputTokens: 6000,
      messages: [
        {
          role: "system",
          content:
            "You are GigPilot's coding worker. Return JSON {summary, files:[{path, content}], testReport:{runner, simulated, passed, failed, tests:[{name,status,durationMs,error?}]}}. " +
            "Include README.md, source files and tests. Secrets only via environment variables. Report tests honestly; set simulated=true if you did not execute them. " +
            "File paths must be relative (no leading '/', no '..').",
        },
        {
          role: "user",
          content: [
            wrapUntrusted("client brief", `Job: ${j.title}\nBrief: ${truncate(j.brief, 2000)}\nAcceptance: ${[...step.acceptance, ...j.acceptanceCriteria].join("; ")}`),
            repair ? `Fix from QA: ${neutraliseDelimiters(repair.hint)}` : "",
            `Reference structure: ${deterministic.files.map((f) => f.path).join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      mockResult: () => deterministic,
    },
    { avoidFamilies: repair?.avoidFamilies },
  );
  const art: CodeArtifact = res.data ?? deterministic;
  // Whatever produced the artifact (model or deterministic generator), make sure every
  // feature the brief names is at least present in the delivered source. Scaffolds are
  // clearly marked as generated and un-executed; real files are never overwritten.
  scaffoldRequestedFeatures(j.serviceFamily === "web-app-builds" ? "web-app-builds" : "ai-automation", codeBrief, art.files);
  if (defect === "failing_test" && art.testReport.failed === 0 && art.testReport.tests.length > 0) {
    const t = art.testReport.tests[art.testReport.tests.length - 1]!;
    t.status = "failed";
    t.error = "assertion failed (simulated defect injected for the demo — demo workspaces only)";
    art.testReport.failed = 1;
    art.testReport.passed = Math.max(0, art.testReport.passed - 1);
  }
  // No sandbox test runner exists: whatever the generator claims, these tests were NOT executed here.
  art.testReport = { ...art.testReport, simulated: true };
  const db = getDb();
  const archive = zipArtifact(art);
  const zip = await storeFile(ctx.deps, db, {
    tenantId: j.tenantId,
    jobId: j.id,
    stepId: step.id,
    filename: `${slugify(j.title, 40)}-source.zip`,
    mime: "application/zip",
    bytes: archive.bytes,
    kind: "code",
    meta: {
      stepKey: step.key,
      attempt,
      files: art.files.length - archive.rejected.length,
      rejectedPaths: archive.rejected,
      provider: res.family,
      model: res.model,
      testReport: { passed: art.testReport.passed, failed: art.testReport.failed, simulated: art.testReport.simulated },
    },
  });
  return {
    output: {
      summary: honestCodeSummary(art.summary),
      files: art.files.map((f) => f.path).filter((p) => !archive.rejected.includes(p)),
      testsExecuted: false,
      rejectedPaths: archive.rejected,
      testReport: art.testReport,
      assets: [{ assetId: zip.id, filename: zip.filename, kind: "code" }],
      provider: res.family,
      model: res.model,
    },
    summary: `${truncate(honestCodeSummary(art.summary), 140)} (${res.family === "mock" ? "deterministic mock" : `${res.family}/${res.model}`}; ${art.testReport.tests.length} test${art.testReport.tests.length === 1 ? "" : "s"} written, not executed)${archive.rejected.length ? ` — ${archive.rejected.length} unsafe path(s) rejected` : ""}`,
  };
}

/**
 * True when a test report carries no evidence that the tests were actually executed.
 * GigPilot has NO sandbox test runner, so every report is unverified: a model's own
 * `simulated: false` claim is never evidence.
 */
export function testsUnverified(_report: CodeArtifact["testReport"] | null | undefined): boolean {
  return true;
}

/** Strip self-reported "N/M tests passing" claims from a model/generator summary. */
export function honestCodeSummary(summary: string): string {
  return summary
    .replace(/,?\s*\d+\s*\/\s*\d+\s+(tests?|checks?)\s+(passing|passed|green)/gi, "")
    .replace(/,?\s*(all\s+)?\d*\s*(tests?|checks?)\s+(are\s+)?(passing|passed|green)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function executeTest(ctx: RunContext, j: JobRow, step: StepRow, all: StepRow[], attempt: number): Promise<StepOutcome> {
  const impl = [...all].reverse().find((s) => s.kind === "code" && upstreamKeys(step, all).has(s.key));
  const report = outputOf(impl).testReport as CodeArtifact["testReport"] | undefined;
  const failed = report?.failed ?? 0;
  // There is no sandbox test runner: tests are never executed here, whatever the report claims.
  const result = !report
    ? "No test report found on the implementation step."
    : `NOT EXECUTED — ${report.tests.length} test${report.tests.length === 1 ? "" : "s"} generated but not executed in this environment (no test runner). ` +
      `The generator self-reports ${report.failed === 0 ? "no failures" : `${report.failed} failing`} — unverified. Run \`npm test\` in the project to verify.`;
  // Deterministic report: no model call (the numbers must never be paraphrased or paid for).
  const markdown = [
    `# ${step.name} — ${j.title}`,
    "",
    "## Result",
    result,
    "",
    "## Tests written (self-reported status, not executed)",
    ...(report?.tests ?? []).map((t) => `- [?] ${t.name}${t.status === "failed" ? ` — self-reported failure${t.error ? `: ${t.error}` : ""}` : ""}`),
    "",
    "## Acceptance criteria (not verified by test execution)",
    ...step.acceptance.map((a) => `- ${a}`),
  ].join("\n");
  const db = getDb();
  const file = await storeFile(ctx.deps, db, {
    tenantId: j.tenantId,
    jobId: j.id,
    stepId: step.id,
    filename: `${step.key}-test-report.md`,
    mime: "text/markdown",
    bytes: strToU8(markdown),
    kind: "document",
    meta: { stepKey: step.key, attempt, testsExecuted: false },
  });
  ctx.provider = "deterministic";
  ctx.model = "test-report";
  return {
    output: { markdown, testReport: report ?? null, testsExecuted: false, assets: [{ assetId: file.id, filename: file.filename, kind: "document" }] },
    summary: !report ? "No tests found" : `Tests generated but not executed in this environment (${report.tests.length} written${failed ? `, ${failed} self-reported failing` : ""})`,
  };
}

async function executeTranslate(ctx: RunContext, j: JobRow, step: StepRow, _all: StepRow[], attempt: number): Promise<StepOutcome> {
  const input = inputOf(step);
  const languages = Array.isArray(input.languages) && input.languages.length ? (input.languages as string[]) : ["Spanish"];
  const items = Math.max(1, Number(input.sourceItems ?? 2));
  const defect = activeDefect(step, attempt);
  const repair = repairOf(step);
  const db = getDb();
  const assets: { assetId: string; filename: string; kind: string }[] = [];
  const cueSchema = z.object({ cues: z.array(z.string().min(1)).min(3).max(40) });
  let first = true;
  let provider = "mock";
  for (const language of languages) {
    await ctx.checkpoint();
    const template = buildSrt({ title: j.title, language, index: 0, overlap: false });
    const cues = template
      .split("\n\n")
      .map((b) => b.split("\n").slice(2).join(" "))
      .filter(Boolean);
    const res = await callIntelligence(ctx, {
      task: "plan_production",
      schema: cueSchema,
      schemaName: "subtitle_cues",
      messages: [
        { role: "system", content: `Translate each subtitle cue into ${language}. Keep brand and product names untranslated. Return JSON {"cues": [...]} with the same number of cues.` },
        { role: "user", content: wrapUntrusted("subtitle cues", cues.join("\n")) },
      ],
      mockResult: () => ({ cues }),
    });
    provider = res.family;
    const translated = res.data?.cues?.length === cues.length ? res.data.cues : cues;
    for (let i = 0; i < items; i++) {
      const base = buildSrt({ title: j.title, language, index: i, overlap: Boolean(defect === "srt_overlap" && first) });
      const blocks = base.trim().split("\n\n").map((b, k) => {
        const [n, time] = b.split("\n");
        return `${n}\n${time}\n${translated[k] ?? ""}`;
      });
      const srt = `${blocks.join("\n\n")}\n`;
      first = false;
      const file = await storeFile(ctx.deps, db, {
        tenantId: j.tenantId,
        jobId: j.id,
        stepId: step.id,
        filename: `${slugify(productPhrase(j.title), 32)}-${String(i + 1).padStart(2, "0")}.${langCode(language)}.srt`,
        mime: "application/x-subrip",
        bytes: strToU8(srt),
        kind: "document",
        meta: { stepKey: step.key, attempt, language, provider: res.family, model: res.model },
      });
      assets.push({ assetId: file.id, filename: file.filename, kind: "document" });
    }
  }
  return {
    output: { assets, languages, sourceItems: items, provider },
    summary: `${assets.length} subtitle files in ${languages.join(", ")}${provider === "mock" ? " (mock translation placeholders)" : ""}${repair ? " — timing repaired" : ""}`,
  };
}

async function loadStepAssets(tenantId: string, step: StepRow): Promise<AssetRow[]> {
  const refs = (outputOf(step).assets as { assetId: string }[] | undefined) ?? [];
  const ids = refs.map((r) => r.assetId).filter(Boolean);
  if (!ids.length) return [];
  return getDb().select().from(asset).where(and(eq(asset.tenantId, tenantId), inArray(asset.id, ids)));
}

async function contactSheet(ctx: RunContext, j: JobRow, images: AssetRow[]): Promise<Uint8Array | null> {
  const svgs = images.filter((a) => a.mime === "image/svg+xml").slice(0, 16);
  if (!svgs.length) return null;
  const storage = storageOf(ctx.deps);
  const cell = 320;
  const cols = Math.min(4, svgs.length);
  const rows = Math.ceil(svgs.length / cols);
  const parts: string[] = [];
  for (const [i, a] of svgs.entries()) {
    const bytes = await storage.get(a.storageKey);
    const x = 24 + (i % cols) * (cell + 24);
    const y = 90 + Math.floor(i / cols) * (cell + 56);
    parts.push(
      `<image x="${x}" y="${y}" width="${cell}" height="${cell}" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${Buffer.from(bytes).toString("base64")}"/>`,
      `<text x="${x}" y="${y + cell + 24}" font-family="Inter, Arial, sans-serif" font-size="14" fill="#333">${a.filename.replace(/[<&>"]/g, "")}</text>`,
    );
  }
  const W = 24 + cols * (cell + 24);
  const H = 90 + rows * (cell + 56);
  const title = j.title.replace(/[<&>"]/g, "");
  return strToU8(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-kind="contact-sheet"><rect width="${W}" height="${H}" fill="#f6f5f2"/><text x="24" y="54" font-family="Schibsted Grotesk, Inter, Arial, sans-serif" font-size="28" font-weight="800" fill="#111">Contact sheet — ${title}</text>${parts.join("")}</svg>`,
  );
}

async function executeAssemble(ctx: RunContext, j: JobRow, step: StepRow, all: StepRow[], attempt: number): Promise<StepOutcome> {
  const upstream = upstreamKeys(step, all);
  const sources = all.filter((s) => upstream.has(s.key) && ["generate", "translate"].includes(s.kind));
  const assets = (await Promise.all(sources.map((s) => loadStepAssets(j.tenantId, s)))).flat();
  const doc = await executeDocument(ctx, j, step, all, attempt, { assetNames: assets.map((a) => a.filename) });
  const outAssets = [...((doc.output.assets as unknown[]) ?? [])];
  const sheet = await contactSheet(ctx, j, assets.filter((a) => a.kind === "image"));
  if (sheet) {
    const file = await storeFile(ctx.deps, getDb(), {
      tenantId: j.tenantId,
      jobId: j.id,
      stepId: step.id,
      filename: `${slugify(j.title, 32)}-contact-sheet.svg`,
      mime: "image/svg+xml",
      bytes: sheet,
      kind: "image",
      meta: { stepKey: step.key, attempt, contactSheet: true, items: assets.length },
    });
    outAssets.push({ assetId: file.id, filename: file.filename, kind: "image" });
  }
  return { output: { ...doc.output, assets: outAssets, assembled: assets.length }, summary: `Assembled ${assets.length} files${sheet ? " + contact sheet" : ""}` };
}

async function executeStep(ctx: RunContext, j: JobRow, step: StepRow, deps: AgentDeps, attempt: number): Promise<StepOutcome> {
  const all = await loadActiveSteps(j.tenantId, j.id);
  if (isQaStep(step)) return runQaStep(ctx, j, step, all, deps);
  switch (step.kind) {
    case "generate":
      return executeGenerate(ctx, j, step, all, attempt);
    case "code":
      return executeCode(ctx, j, step, all, attempt);
    case "test":
      return executeTest(ctx, j, step, all, attempt);
    case "translate":
      return executeTranslate(ctx, j, step, all, attempt);
    case "assemble":
      return executeAssemble(ctx, j, step, all, attempt);
    default:
      return executeDocument(ctx, j, step, all, attempt);
  }
}

function isStale(err: unknown): boolean {
  return err instanceof ConcurrentTransitionError || err instanceof InvalidTransitionError;
}

/**
 * Write a step outcome only if the step is still RUNNING THIS ATTEMPT. A late
 * result from an attempt that timed out (and was already failed/retried by
 * the job monitor) is discarded with an event instead of overwriting newer
 * state. Returns false when discarded.
 */
async function writeOutcome(
  deps: AgentDeps,
  input: Omit<TransitionInput, "expectFrom" | "match" | "machine"> & { attempt: number; jobId: string; stepName: string },
): Promise<boolean> {
  const { attempt, jobId, stepName, ...rest } = input;
  try {
    await transition(getDb(), { ...rest, machine: "step", expectFrom: ["running"], match: { attempts: attempt } });
    return true;
  } catch (err) {
    if (!isStale(err)) throw err;
    deps.log.warn({ stepId: rest.id, attempt, error: safeError(err, 200) }, "stale step result discarded");
    await emitEvent(getDb(), {
      tenantId: rest.tenantId,
      type: "step.stale_result",
      level: "warn",
      agent: "orchestrator",
      subjectType: "step",
      subjectId: rest.id,
      jobId,
      message: `Discarded a late result for ${stepName} (attempt ${attempt}) — the step has moved on`,
      data: { attempt, attemptedTo: rest.to },
    });
    return false;
  }
}

async function tick(deps: AgentDeps, tenantId: string, jobId: string) {
  try {
    await deps.queue.send(QUEUES.workflowTick, { tenantId, jobId }, { singletonKey: jobId });
  } catch (err) {
    // During shutdown the queue may already be stopping; the job monitor re-ticks active jobs.
    deps.log.warn({ jobId, error: safeError(err, 200) }, "could not enqueue workflow tick");
  }
}

/**
 * step-execute handler. Claims the step with a lock-like transition (ready →
 * running for exactly this attempt — a racing duplicate stops), runs it as a
 * new agent_run with the queue's abort signal, records the outcome only if
 * the step is still on this attempt, triggers Recovery on a QA failure and
 * always re-ticks the workflow. Errors are handled here (pg-boss retryLimit
 * is 0 for this queue): the orchestrator retries failed steps within
 * maxAttempts. A shutdown returns the step to `ready` without consuming the
 * attempt; an ambiguous paid submission blocks it for the owner.
 */
export async function runStepExecute(payload: QueuePayloads["step-execute"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, jobId, stepId, attempt } = payload;
  const [j] = await db.select().from(job).where(and(eq(job.id, jobId), eq(job.tenantId, tenantId))).limit(1);
  const [step] = await db.select().from(workflowStep).where(and(eq(workflowStep.id, stepId), eq(workflowStep.tenantId, tenantId))).limit(1);
  if (!j || !step) return { status: "skipped" as const, reason: "not found" };
  if (!["executing", "qa", "repairing"].includes(j.status)) return { status: "skipped" as const, reason: `job is ${j.status}` };
  if (step.status !== "ready" || step.attempts + 1 !== attempt) return { status: "skipped" as const, reason: `stale dispatch (step ${step.status}, attempts ${step.attempts})` };
  if (abortReasonOf(deps)) return { status: "skipped" as const, reason: "worker is stopping" };

  const actor = { type: "agent" as const, id: step.agent };
  const agent = agentKey(step.agent);
  try {
    await transition(db, {
      machine: "step",
      id: step.id,
      tenantId,
      to: "running",
      actor,
      expectFrom: ["ready"],
      requireChange: true,
      match: { attempts: attempt - 1 },
      patch: { attempts: attempt, startedAt: new Date(), finishedAt: null, error: null },
      event: {
        type: "step.started",
        level: "info",
        agent,
        subjectType: "step",
        subjectId: step.id,
        jobId,
        message: `${AGENTS[agent].name} started ${step.name}${attempt > 1 ? ` (attempt ${attempt}/${step.maxAttempts})` : ""} for ${quote(j.title, 50)}`,
      },
    });
  } catch (err) {
    if (isStale(err)) return { status: "skipped" as const, reason: "another worker claimed this attempt" };
    throw err;
  }
  const running = { ...step, status: "running" as const, attempts: attempt };

  let outcome: StepOutcome;
  let runId: string | null = null;
  try {
    outcome = await runAgent(
      {
        deps,
        tenantId,
        agent,
        task: `step.${step.kind}`,
        subjectType: "step",
        subjectId: step.id,
        jobId,
        stepId: step.id,
        attempt,
        idempotencyKey: `step:${step.id}:${attempt}`,
        label: `${step.name}`,
      },
      async (ctx) => {
        runId = ctx.runId;
        await ctx.checkpoint();
        const o = await executeStep(ctx, j, running, deps, attempt);
        await ctx.checkpoint();
        ctx.summary = o.summary;
        return o;
      },
    );
  } catch (err) {
    const message = safeError(err, 400);
    const reason = abortReasonOf(deps) ?? (err instanceof StepAbortedError ? err.reason : null);

    // Worker shutdown: hand the step back WITHOUT consuming the attempt; the restarted worker resumes it.
    if (reason === "shutdown") {
      const ok = await writeOutcome(deps, {
        id: step.id,
        tenantId,
        to: "ready",
        actor: { type: "system", id: "worker-shutdown" },
        reason: "interrupted by worker shutdown — attempt not consumed",
        patch: { attempts: attempt - 1, startedAt: null, error: null },
        event: { type: "step.interrupted", level: "warn", agent, subjectType: "step", subjectId: step.id, jobId, message: `${step.name} was interrupted by a worker restart — it will resume without using an attempt` },
        attempt,
        jobId,
        stepName: step.name,
      });
      await tick(deps, tenantId, jobId);
      return { status: ok ? ("interrupted" as const) : ("stale" as const), error: message };
    }

    // Owner cancelled the job: the cancel cascade already closed the step.
    if (reason === "cancelled") {
      await writeOutcome(deps, {
        id: step.id,
        tenantId,
        to: "cancelled",
        actor: { type: "system", id: "cancel" },
        reason: "job cancelled",
        patch: { finishedAt: new Date(), error: "job cancelled" },
        attempt,
        jobId,
        stepName: step.name,
      });
      return { status: "cancelled" as const };
    }

    // The provider may have accepted a paid job: never retry automatically.
    if (isProviderError(err) && err.code === "ambiguous_submission") {
      const ok = await writeOutcome(deps, {
        id: step.id,
        tenantId,
        to: "blocked",
        actor: { type: "agent", id: "orchestrator" },
        reason: "provider submission outcome unknown — owner must verify",
        patch: { error: message, finishedAt: new Date(), output: { ...outputOf(step), blockedReason: "ambiguous_submission", blockedAt: new Date().toISOString(), provider: err.provider } },
        event: { type: "step.blocked", level: "warn", agent, subjectType: "step", subjectId: step.id, jobId, message: `${step.name} paused: ${err.provider} may have accepted the request — verify on the provider before retrying` },
        attempt,
        jobId,
        stepName: step.name,
      });
      if (ok) {
        await notify(db, {
          tenantId,
          kind: "alert",
          title: `Verify on ${err.provider} before retrying “${step.name.slice(0, 60)}”`,
          body: `“${j.title.slice(0, 80)}”: the request to ${err.provider} timed out or was interrupted after it was sent, so it may have been accepted (and billed). Check the ${err.provider} dashboard, then resume the job — GigPilot will not resubmit automatically.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `ambiguous-step:${step.id}:${attempt}`,
        });
      }
      await tick(deps, tenantId, jobId);
      return { status: ok ? ("blocked" as const) : ("stale" as const), error: message };
    }

    const blocked = err instanceof BudgetBlockedError;
    const ok = await writeOutcome(deps, {
      id: step.id,
      tenantId,
      to: "failed",
      actor,
      patch: { error: reason === "timeout" ? `Timed out: ${message}` : message, finishedAt: new Date() },
      event: {
        type: "step.failed",
        level: blocked ? "warn" : "error",
        agent,
        subjectType: "step",
        subjectId: step.id,
        jobId,
        message: `${step.name} failed (attempt ${attempt}/${step.maxAttempts}): ${truncate(message, 200)}`,
      },
      attempt,
      jobId,
      stepName: step.name,
    });
    if (ok && blocked) {
      await transition(db, {
        machine: "step",
        id: step.id,
        tenantId,
        to: "blocked",
        actor: { type: "agent", id: "orchestrator" },
        reason: "spend limit — waiting for the owner",
        expectFrom: ["failed"],
        patch: { output: { ...outputOf(step), blockedReason: "budget", blockedAt: new Date().toISOString() } },
      });
    }
    await tick(deps, tenantId, jobId);
    if (!ok) return { status: "stale" as const, error: message };
    return { status: blocked ? ("blocked" as const) : ("failed" as const), error: message };
  }

  if (outcome.verdict === "fail") {
    const ok = await writeOutcome(deps, {
      id: step.id,
      tenantId,
      to: "failed",
      actor,
      patch: { output: outcome.output, error: truncate(outcome.summary, 500), finishedAt: new Date() },
      attempt,
      jobId,
      stepName: step.name,
    });
    if (!ok) return { status: "stale" as const };
    await recoverFromQaFailure({ tenantId, jobId, qaStepId: step.id, parentRunId: runId }, deps);
    await tick(deps, tenantId, jobId);
    return { status: "qa_failed" as const, summary: outcome.summary };
  }

  const ok = await writeOutcome(deps, {
    id: step.id,
    tenantId,
    to: "succeeded",
    actor,
    patch: {
      output: outcome.output,
      finishedAt: new Date(),
      provider: typeof outcome.output.provider === "string" ? outcome.output.provider : null,
      model: typeof outcome.output.model === "string" ? outcome.output.model : null,
    },
    event: {
      type: "step.succeeded",
      level: "success",
      agent,
      subjectType: "step",
      subjectId: step.id,
      jobId,
      message: `${step.name} done — ${truncate(outcome.summary, 200)}`,
    },
    attempt,
    jobId,
    stepName: step.name,
  });
  if (!ok) return { status: "stale" as const, summary: outcome.summary };
  await tick(deps, tenantId, jobId);
  return { status: "succeeded" as const, summary: outcome.summary };
}
