import { strFromU8, unzipSync } from "fflate";
import { qaVerdictSchema, type QAFinding, type QAVerdict } from "@gigpilot/contracts";
import { and, asset, emitEvent, eq, generation, getDb, inArray, qaReview, repair, tenant } from "@gigpilot/db";
import { wrapUntrusted } from "@gigpilot/providers";
import { storageOf, type AgentDeps } from "../deps";
import { requiredSections } from "../heuristics/content";
import { REVIEWABLE_KINDS } from "../heuristics/workflows";
import { GLYPH_ADVANCE, aspectMatches, checkSrt, describeAspect, inspectImage, inspectSvgLayout, svgRootAttributes } from "../lib/media";
import { clamp, quote, truncate } from "../lib/util";
import { callIntelligence, type AssetRow, type JobRow, type RunContext, type StepRow } from "../runtime";
import type { StepOutcome } from "./execution";

export interface StepCheck {
  findings: QAFinding[];
  failingUnits: number[];
  failingGenerationIds: string[];
  checked: number;
  evidence: string[];
}

export interface StepReview {
  stepId: string;
  stepKey: string;
  stepName: string;
  verdict: "pass" | "fail";
  score: number;
  findings: QAFinding[];
  failingUnits: number[];
  failingGenerationIds: string[];
  reviewId: string;
  reviewer: { provider: string; model: string };
}

const INTELLIGENCE_FAMILIES = new Set(["gx", "factory", "grok"]);

function outputOf(s: StepRow): Record<string, unknown> {
  return (s.output ?? {}) as Record<string, unknown>;
}
function inputOf(s: StepRow): Record<string, unknown> {
  return (s.input ?? {}) as Record<string, unknown>;
}

async function assetsById(tenantId: string, ids: string[]): Promise<Map<string, AssetRow>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select().from(asset).where(and(eq(asset.tenantId, tenantId), inArray(asset.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

function upstreamOf(step: StepRow, all: StepRow[]): Set<string> {
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

function criterion(step: StepRow, re: RegExp): string | undefined {
  return step.acceptance.find((a) => re.test(a));
}

/** Deterministic, provider-independent checks on a step's CURRENT outputs. */
export async function deterministicChecks(deps: AgentDeps, j: JobRow, step: StepRow): Promise<StepCheck> {
  const storage = storageOf(deps);
  const out = outputOf(step);
  const input = inputOf(step);
  const res: StepCheck = { findings: [], failingUnits: [], failingGenerationIds: [], checked: 0, evidence: [] };
  const refs = ((out.assets as { assetId: string }[] | undefined) ?? []).map((a) => a.assetId);
  const byId = await assetsById(j.tenantId, refs);

  const load = async (a: AssetRow): Promise<Uint8Array | null> => {
    if (!(await storage.exists(a.storageKey))) {
      res.findings.push({ code: "file_missing", severity: "critical", message: `${a.filename} is missing from storage`, repairHint: "Regenerate the file" });
      return null;
    }
    const bytes = await storage.get(a.storageKey);
    if (bytes.byteLength === 0) {
      res.findings.push({ code: "empty_file", severity: "critical", message: `${a.filename} is empty`, repairHint: "Regenerate the file" });
      return null;
    }
    return bytes;
  };

  if (step.kind === "generate") {
    const ar = typeof input.aspectRatio === "string" ? input.aspectRatio : null;
    const items = (out.items as { unitIndex: number; generationId: string; assetIds: string[] }[] | undefined) ?? [];
    for (const item of items) {
      const before = res.findings.length;
      for (const id of item.assetIds) {
        const a = byId.get(id) ?? (await assetsById(j.tenantId, [id])).get(id);
        if (!a) {
          res.findings.push({ code: "file_missing", severity: "critical", message: `Asset for #${item.unitIndex + 1} not found`, repairHint: "Regenerate the file" });
          continue;
        }
        const bytes = await load(a);
        if (!bytes) continue;
        res.checked++;
        if (a.mime === "application/json") {
          try {
            const shot = JSON.parse(strFromU8(bytes)) as { shots?: unknown[] };
            if (!Array.isArray(shot.shots) || shot.shots.length < 3) {
              res.findings.push({ code: "invalid_shotlist", severity: "major", message: `${a.filename} has fewer than 3 shots`, repairHint: "Rebuild the shot list" });
            }
          } catch {
            res.findings.push({ code: "invalid_shotlist", severity: "major", message: `${a.filename} is not valid JSON`, repairHint: "Rebuild the shot list" });
          }
          continue;
        }
        if (!a.mime.startsWith("image/")) continue;
        const text = a.mime === "image/svg+xml" ? strFromU8(bytes) : null;
        const attrs = text ? svgRootAttributes(text) : {};
        if (attrs["data-kind"] === "storyboard") {
          const fw = Number(attrs["data-frame-width"]);
          const fh = Number(attrs["data-frame-height"]);
          if (ar && !(fw > 0 && fh > 0 && aspectMatches(fw, fh, ar))) {
            res.findings.push({
              code: "aspect_ratio",
              severity: "major",
              message: `Storyboard #${item.unitIndex + 1} frames are ${fw}×${fh} (${describeAspect(fw, fh)}) but the brief requires ${ar}`,
              criterion: criterion(step, /aspect/i),
              repairHint: `Re-frame every shot to ${ar}`,
            });
          }
          res.evidence.push(`#${item.unitIndex + 1} storyboard frames ${fw}×${fh}`);
          continue;
        }
        const info = inspectImage(bytes, a.mime);
        if (!info.width || !info.height) {
          res.findings.push({ code: "unreadable_image", severity: "major", message: `Could not read dimensions of ${a.filename}`, repairHint: "Regenerate in PNG/JPEG/SVG" });
          continue;
        }
        res.evidence.push(`#${item.unitIndex + 1} ${info.format} ${info.width}×${info.height}`);
        if (ar && !aspectMatches(info.width, info.height, ar)) {
          res.findings.push({
            code: "aspect_ratio",
            severity: "major",
            message: `Creative #${item.unitIndex + 1} is ${info.width}×${info.height} (${describeAspect(info.width, info.height)}) but the brief requires ${ar}`,
            criterion: criterion(step, /aspect/i),
            repairHint: `Re-frame to ${ar} and keep logo and headline inside the safe zone`,
          });
        }
        if (text) {
          const layout = inspectSvgLayout(text);
          const margin = layout.safeMargin ?? Math.round(Math.min(info.width, info.height) * 0.06);
          const tol = margin * 0.9;
          if (
            layout.logo &&
            (layout.logo.x < tol || layout.logo.y < tol || layout.logo.x + layout.logo.width > info.width - tol || layout.logo.y + layout.logo.height > info.height - tol)
          ) {
            res.findings.push({ code: "missing_logo_safe_zone", severity: "major", message: `Creative #${item.unitIndex + 1}: logo sits outside the ${margin}px safe zone`, criterion: criterion(step, /logo|safe/i), repairHint: "Move the logo inside the safe zone" });
          }
          if (layout.headline && layout.headline.fontSize > 0) {
            const widest = Math.max(...layout.headline.lines.map((l) => l.length)) * layout.headline.fontSize * GLYPH_ADVANCE;
            if (widest > info.width - margin * 2 + 1) {
              res.findings.push({ code: "text_overflow", severity: "major", message: `Creative #${item.unitIndex + 1}: headline (~${Math.round(widest)}px) overflows the ${info.width - margin * 2}px text area`, criterion: criterion(step, /headline|fit/i), repairHint: "Wrap or shrink the headline to fit" });
            }
          }
        }
      }
      if (res.findings.length > before) {
        res.failingUnits.push(item.unitIndex);
        res.failingGenerationIds.push(item.generationId);
      }
    }
    if (items.length === 0) res.findings.push({ code: "no_output", severity: "critical", message: "No creatives were produced", repairHint: "Regenerate the batch" });
    return res;
  }

  const assets = [...byId.values()];
  if (step.kind === "code") {
    const zip = assets.find((a) => a.mime === "application/zip");
    const bytes = zip ? await load(zip) : null;
    if (!zip) res.findings.push({ code: "file_missing", severity: "critical", message: "No source archive produced", repairHint: "Rebuild and package the source" });
    if (bytes) {
      res.checked++;
      try {
        const files = unzipSync(bytes);
        const names = Object.keys(files);
        res.evidence.push(`${names.length} files in archive`);
        if (!names.some((n) => /readme\.md$/i.test(n))) res.findings.push({ code: "missing_readme", severity: "major", message: "Archive has no README.md", criterion: criterion(step, /readme/i), repairHint: "Add setup and usage documentation" });
        if (names.filter((n) => /\.(ts|tsx|js|py|json)$/.test(n)).length < 2) res.findings.push({ code: "missing_source", severity: "critical", message: "Archive contains no source files", repairHint: "Include the implementation" });
        const reportFile = names.find((n) => n.endsWith("test-report.json"));
        const report = reportFile
          ? (JSON.parse(strFromU8(files[reportFile]!)) as { failed?: number; passed?: number; simulated?: boolean; tests?: { name: string; status: string; error?: string }[] })
          : null;
        if (!report) res.findings.push({ code: "missing_tests", severity: "major", message: "No test report in the archive", criterion: criterion(step, /test/i), repairHint: "Add tests and a test report" });
        else if ((report.failed ?? 0) > 0) {
          const failing = (report.tests ?? []).filter((t) => t.status === "failed");
          res.findings.push({
            code: "failing_tests",
            severity: "major",
            message: `${report.failed} failing test${report.failed === 1 ? "" : "s"}: ${failing.map((t) => `${t.name}${t.error ? ` (${t.error})` : ""}`).join("; ")}`,
            criterion: criterion(step, /tests? pass/i),
            repairHint: `Fix the failing test${report.failed === 1 ? "" : "s"}: ${failing.map((t) => t.name).join(", ")}`,
          });
        } else if (report.simulated === true || !Array.isArray(report.tests) || report.tests.length === 0) {
          // Self-reported results are not evidence: never claim "N tests passing" for a simulated run.
          res.findings.push(testsNotExecuted());
          res.evidence.push("tests generated but not executed in this environment");
        } else res.evidence.push(`${report.passed ?? 0} tests passing`);
        const secretLike = names.find((n) => /(^|\/)\.env$/.test(n));
        if (secretLike) res.findings.push({ code: "secret_file", severity: "critical", message: "Archive contains a .env file", repairHint: "Remove secrets; ship .env.example only" });
      } catch {
        res.findings.push({ code: "corrupt_archive", severity: "critical", message: "Source archive cannot be opened", repairHint: "Re-package the source" });
      }
    }
    return res;
  }

  if (step.kind === "test") {
    const report = out.testReport as { failed?: number; passed?: number; simulated?: boolean; tests?: unknown[] } | null | undefined;
    res.checked++;
    if (!report) res.findings.push({ code: "missing_tests", severity: "major", message: "No test results recorded", repairHint: "Run the test suite" });
    else if ((report.failed ?? 0) > 0) res.findings.push({ code: "failing_tests", severity: "major", message: `Test run reports ${report.failed} failure(s)`, repairHint: "Fix the failing tests upstream" });
    else if (report.simulated === true || !Array.isArray(report.tests) || report.tests.length === 0) {
      res.findings.push(testsNotExecuted());
      res.evidence.push("tests generated but not executed in this environment");
    }
    return res;
  }

  if (step.kind === "translate") {
    for (const a of assets) {
      const bytes = await load(a);
      if (!bytes) continue;
      res.checked++;
      const { cues, problems } = checkSrt(strFromU8(bytes));
      res.evidence.push(`${a.filename}: ${cues} cues`);
      if (problems.length) {
        res.findings.push({ code: "srt_timing", severity: "major", message: `${a.filename}: ${problems.slice(0, 2).join("; ")}`, criterion: criterion(step, /srt|overlap/i), repairHint: "Re-time the cues so none overlap" });
      }
    }
    if (assets.length === 0) res.findings.push({ code: "no_output", severity: "critical", message: "No subtitle files produced", repairHint: "Produce the subtitle files" });
    return res;
  }

  // Documents (brief, research, concepts, copy, assemble, finalize).
  const docs = assets.filter((a) => a.mime === "text/markdown");
  for (const a of docs) {
    const bytes = await load(a);
    if (!bytes) continue;
    res.checked++;
    const text = strFromU8(bytes);
    if (text.trim().length < 200) res.findings.push({ code: "too_short", severity: "minor", message: `${a.filename} is only ${text.trim().length} characters`, repairHint: "Expand with specifics from the brief" });
    for (const section of requiredSections(step.kind, j.serviceFamily)) {
      if (!text.toLowerCase().includes(section.toLowerCase())) {
        res.findings.push({ code: "missing_section", severity: "major", message: `${a.filename} is missing the “${section.replace(/^## /, "")}” section`, criterion: criterion(step, /section|sources/i), repairHint: `Add a “${section.replace(/^## /, "")}” section` });
      }
    }
  }
  if (docs.length === 0 && step.kind !== "assemble") res.findings.push({ code: "no_output", severity: "critical", message: "No document produced", repairHint: "Write the deliverable" });
  return res;
}

/** QA finding for a code/test step whose test report carries no execution evidence. */
export function testsNotExecuted(): QAFinding {
  return {
    code: "tests_not_executed",
    severity: "minor",
    message: "Tests were generated but not executed in this environment — results are self-reported and unverified",
    repairHint: "Run the test suite in a real environment (npm test) before relying on it",
  };
}

/**
 * Live workspaces must never silently ship simulated work: a deliverable
 * produced by the mock provider gets a MAJOR finding (fails QA → owner).
 */
export function mockProductionFindings(step: StepRow): { findings: QAFinding[]; failingUnits: number[]; failingGenerationIds: string[] } {
  const out = outputOf(step);
  const findings: QAFinding[] = [];
  const failingUnits: number[] = [];
  const failingGenerationIds: string[] = [];
  if (step.kind === "generate") {
    const items = (out.items as { unitIndex: number; generationId: string; mode?: string; provider?: string }[] | undefined) ?? [];
    for (const i of items) {
      if (i.mode === "mock" || i.provider === "mock") {
        failingUnits.push(i.unitIndex);
        failingGenerationIds.push(i.generationId);
      }
    }
    if (failingUnits.length) {
      findings.push({
        code: "produced_by_mock",
        severity: "major",
        message: `${failingUnits.length} of ${items.length} creatives were rendered by the mock provider (simulated placeholders, not deliverable work)`,
        repairHint: "Configure a creative provider (and paid spend) so the units can be generated for real",
      });
    }
  } else if (out.provider === "mock") {
    findings.push({
      code: "produced_by_mock",
      severity: "major",
      message: `${step.name} was produced by the deterministic mock provider (no model was available) — not deliverable work for a live workspace`,
      repairHint: "Configure an intelligence provider (GX or Factory) and re-run the step",
    });
  }
  return { findings, failingUnits, failingGenerationIds };
}

export function deterministicVerdict(check: StepCheck, stepName: string): QAVerdict {
  const major = check.findings.filter((f) => f.severity === "major").length;
  const critical = check.findings.filter((f) => f.severity === "critical").length;
  const minor = check.findings.filter((f) => f.severity === "minor").length;
  const fail = major + critical > 0;
  const score = clamp(0.96 - 0.35 * major - 0.6 * critical - 0.06 * minor, 0, 1);
  return {
    verdict: fail ? "fail" : "pass",
    score: Math.round(score * 100) / 100,
    findings: check.findings,
    summary: fail
      ? `${stepName}: ${check.findings.filter((f) => f.severity !== "minor").map((f) => f.message).join("; ")}`
      : `${stepName}: ${check.checked} file${check.checked === 1 ? "" : "s"} checked — meets the acceptance criteria${check.evidence.length ? ` (${check.evidence.slice(0, 3).join(", ")})` : ""}`,
  };
}

/**
 * QA Evaluator. For every reviewable upstream step: deterministic checks on
 * the actual files (dimensions from real headers, required sections, test
 * reports, subtitle timing) plus an LLM review routed AWAY from the family
 * that produced the work whenever an alternative exists. A step fails on any
 * major/critical deterministic finding, or when the LLM fails it with a low
 * score.
 */
export async function runQaStep(ctx: RunContext, j: JobRow, qaStep: StepRow, all: StepRow[], deps: AgentDeps): Promise<StepOutcome> {
  const db = getDb();
  const upstream = upstreamOf(qaStep, all);
  const targets = all.filter((s) => upstream.has(s.key) && REVIEWABLE_KINDS.has(s.kind) && s.status === "succeeded");
  const reviews: StepReview[] = [];
  const [t] = await db.select({ mode: tenant.mode }).from(tenant).where(eq(tenant.id, j.tenantId)).limit(1);
  const live = t?.mode === "live";

  for (const s of targets) {
    await ctx.checkpoint();
    const check = await deterministicChecks(deps, j, s);
    if (live) {
      const mock = mockProductionFindings(s);
      check.findings.push(...mock.findings);
      for (const u of mock.failingUnits) if (!check.failingUnits.includes(u)) check.failingUnits.push(u);
      for (const g of mock.failingGenerationIds) if (!check.failingGenerationIds.includes(g)) check.failingGenerationIds.push(g);
    }
    const baseline = deterministicVerdict(check, s.name);
    const producer = typeof outputOf(s).provider === "string" ? (outputOf(s).provider as string) : s.provider;
    const excerpt = typeof outputOf(s).markdown === "string" ? truncate(outputOf(s).markdown as string, 1500) : JSON.stringify(outputOf(s).testReport ?? outputOf(s).items ?? {}).slice(0, 1500);
    const llm = await callIntelligence(
      ctx,
      {
        task: ["code", "test", "copy"].includes(s.kind) ? "qa_high" : "qa_basic",
        schema: qaVerdictSchema,
        schemaName: "qa_verdict",
        maxOutputTokens: 900,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are GigPilot's independent QA evaluator. Judge the work strictly against the acceptance criteria and the deterministic check results. " +
              "Return JSON qa_verdict {verdict, score 0..1, findings[{code, severity, message, criterion?, repairHint?}], summary}. Be concise and factual.",
          },
          {
            role: "user",
            content: [
              `Step: ${s.name} (${s.kind})`,
              `Deterministic checks: ${check.findings.length ? check.findings.map((f) => `[${f.severity}] ${f.message}`).join("; ") : "all passed"} (${check.evidence.slice(0, 6).join(", ")})`,
              wrapUntrusted("job and acceptance criteria", `Job: ${j.title}\nAcceptance criteria: ${[...s.acceptance].join("; ") || "as briefed"}`),
              `Output excerpt (the work under review):\n${wrapUntrusted("output excerpt", excerpt)}`,
            ].join("\n"),
          },
        ],
        mockResult: () => baseline,
      },
      { avoidFamilies: producer && INTELLIGENCE_FAMILIES.has(producer) ? [producer] : undefined },
    );
    const model = llm.data ?? baseline;
    const deterministicFail = baseline.verdict === "fail";
    const llmFail = llm.family !== "mock" && model.verdict === "fail" && model.score < 0.5;
    const verdict: "pass" | "fail" = deterministicFail || llmFail ? "fail" : "pass";
    const findings = [...check.findings, ...(llm.family !== "mock" ? model.findings.filter((f) => !check.findings.some((c) => c.code === f.code)).slice(0, 5) : [])];
    const score = Math.round(Math.min(baseline.score, llm.family !== "mock" ? model.score : 1) * 100) / 100;
    const summary = verdict === "fail" ? (deterministicFail ? baseline.summary : `${s.name}: ${model.summary}`) : baseline.summary;
    const [row] = await db
      .insert(qaReview)
      .values({
        tenantId: j.tenantId,
        jobId: j.id,
        stepId: s.id,
        generationId: check.failingGenerationIds[0] ?? null,
        reviewer: "qa",
        provider: llm.family,
        model: llm.model,
        verdict,
        score,
        findings,
        summary: truncate(summary, 1000),
        attempt: ctx.attempt,
      })
      .returning({ id: qaReview.id });
    if (s.kind === "generate") {
      const items = (outputOf(s).items as { generationId: string }[] | undefined) ?? [];
      const ids = items.map((i) => i.generationId).filter(Boolean);
      const failing = new Set(check.failingGenerationIds);
      const passIds = ids.filter((id) => !failing.has(id));
      if (passIds.length) await db.update(generation).set({ qaPassed: true }).where(and(eq(generation.tenantId, j.tenantId), inArray(generation.id, passIds)));
      if (failing.size) await db.update(generation).set({ qaPassed: false }).where(and(eq(generation.tenantId, j.tenantId), inArray(generation.id, [...failing])));
    }
    reviews.push({
      stepId: s.id,
      stepKey: s.key,
      stepName: s.name,
      verdict,
      score,
      findings,
      failingUnits: check.failingUnits,
      failingGenerationIds: check.failingGenerationIds,
      reviewId: row!.id,
      reviewer: { provider: llm.family, model: llm.model },
    });
  }

  const failed = reviews.filter((r) => r.verdict === "fail");
  const reviewer = reviews[0]?.reviewer ?? { provider: "mock", model: "mock-deterministic" };
  if (failed.length === 0) {
    const openRepairs = await db.select().from(repair).where(and(eq(repair.jobId, j.id), eq(repair.status, "running")));
    for (const r of openRepairs) {
      await db.update(repair).set({ status: "succeeded" }).where(eq(repair.id, r.id));
      const target = all.find((s) => s.id === r.stepId);
      await emitEvent(db, {
        tenantId: j.tenantId,
        type: "repair.completed",
        level: "success",
        agent: "recovery",
        runId: ctx.runId,
        jobId: j.id,
        subjectType: "step",
        subjectId: r.stepId,
        message: `Repaired ${target ? target.name : "step"} (${r.strategy}) — independent QA now passes`,
      });
    }
    const summary = `Independent QA passed ${reviews.length}/${reviews.length} deliverable checks for ${quote(j.title, 50)} (reviewer ${reviewer.provider}/${reviewer.model})`;
    await emitEvent(db, { tenantId: j.tenantId, type: "qa.passed", level: "success", agent: "qa", runId: ctx.runId, jobId: j.id, subjectType: "job", subjectId: j.id, message: summary, data: { reviews: reviews.map((r) => ({ step: r.stepKey, score: r.score })) } });
    return { output: { verdict: "pass", reviews, reviewer, provider: reviewer.provider, model: reviewer.model }, summary, verdict: "pass" };
  }

  const firstFinding = failed[0]!.findings.find((f) => f.severity !== "minor") ?? failed[0]!.findings[0];
  const summary = `QA failed ${failed.length} of ${reviews.length} checks on ${quote(j.title, 50)}: ${firstFinding?.message ?? failed[0]!.stepName}`;
  await emitEvent(db, {
    tenantId: j.tenantId,
    type: "qa.failed",
    level: "warn",
    agent: "qa",
    runId: ctx.runId,
    jobId: j.id,
    subjectType: "job",
    subjectId: j.id,
    message: truncate(summary, 400),
    data: { failed: failed.map((r) => ({ step: r.stepKey, findings: r.findings.map((f) => f.code) })) },
  });
  return { output: { verdict: "fail", reviews, reviewer, provider: reviewer.provider, model: reviewer.model }, summary, verdict: "fail" };
}
