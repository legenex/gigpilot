import { strFromU8, unzipSync, unzlibSync } from "fflate";
import { env } from "@gigpilot/config";
import { DEMO_INJECTED_DEFECT_MESSAGE, QA_FINDING_CODES, qaVerdictSchema, type IntelligenceTask, type OpportunityAnalysis, type QAFinding, type QAVerdict } from "@gigpilot/contracts";
import { and, asset, desc, emitEvent, eq, generation, getDb, inArray, opportunity, opportunityAnalysis, qaReview, repair, tenant } from "@gigpilot/db";
import { wrapUntrusted } from "@gigpilot/providers";
import { storageOf, type AgentDeps } from "../deps";
import { requiredSections } from "../heuristics/content";
import { CODE_FAMILIES, briefRequiresTests, detectRequestedFeatures, featureByLabel, featureCoverage, type ArtifactFile, type FeatureDef } from "../heuristics/features";
import { REVIEWABLE_KINDS } from "../heuristics/workflows";
import { GLYPH_ADVANCE, aspectMatches, checkSrt, describeAspect, inspectImage, inspectSvgLayout, perceptualSignature, sameLook, svgRootAttributes, type PerceptualSignature } from "../lib/media";
import { clamp, quote, truncate } from "../lib/util";
import { callIntelligence, type AssetRow, type JobRow, type RunContext, type StepRow } from "../runtime";
import type { StepOutcome } from "./execution";

export interface StepCheck {
  findings: QAFinding[];
  failingUnits: number[];
  failingGenerationIds: string[];
  checked: number;
  evidence: string[];
  /** What was verified deterministically (for delivery notes). */
  verified?: string[];
  /** What could not be verified (for delivery notes). */
  notVerified?: string[];
  /** Per-unit fingerprints of a generate step (cross-batch uniqueness). */
  units?: { unitIndex: number; label: number; generationId: string; shas: string[]; sigs: PerceptualSignature[] }[];
  /** Artifact file list + key excerpts for the model review (code steps). */
  artifact?: { files: string[]; excerpt: string };
}

/** Review independence recorded on qa_review.independence. */
export type ReviewIndependence = "independent" | "same_model" | "deterministic_only";

export const INDEPENDENCE_LABEL: Record<ReviewIndependence, string> = {
  independent: "independent review (different model)",
  same_model: "separate review pass (same model)",
  deterministic_only: "deterministic checks only (no model review)",
};

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
  /** How independent the model review was (see INDEPENDENCE_LABEL). */
  independence?: ReviewIndependence;
  producer?: { provider: string | null; model: string | null };
  verified?: string[];
  notVerified?: string[];
}

/** Context shared by every deterministic check of one QA run. */
export interface QaContext {
  /** Original brief text (listing title + description). */
  brief: string;
  /** Brief explicitly requires tests / CI → tests_not_executed is MAJOR. */
  requiresTests: boolean;
  /** Features the brief explicitly asked for (code deliverables). */
  features: FeatureDef[];
  analysis: OpportunityAnalysis | null;
}

/** An owner decision recorded on the QA step (acceptQaFindings). */
export interface AcceptedFinding {
  code: string;
  stepKey?: string | null;
  note: string;
  by: string;
  at: string;
}

const INTELLIGENCE_FAMILIES = new Set(["gx", "factory", "grok"]);

/** Demo defect → the finding code it produces (for labelling). */
const DEMO_DEFECT_FINDING: Record<string, string> = { aspect_ratio: "aspect_ratio", failing_test: "failing_tests", srt_overlap: "srt_timing", missing_section: "missing_section" };

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

/**
 * QA finding for a code/test deliverable: no runner executed the tests.
 * Always NON-BLOCKING (minor): the environment has no test runner, so this is a
 * disclosure about GigPilot, not a defect in the deliverable. It stays visible in
 * the review, the delivery notes and the package. (A blocking major here would make
 * every code brief that asks for tests undeliverable — a permanent dead end.)
 */
export function testsNotExecuted(briefRequiresTests = false): QAFinding {
  return {
    code: QA_FINDING_CODES.testsNotExecuted,
    severity: "minor",
    message: briefRequiresTests
      ? "The brief asks for tests; GigPilot has no test runner, so the generated tests were NOT executed — results are self-reported and unverified"
      : "Tests were generated but not executed in this environment — results are self-reported and unverified",
    repairHint: "Run the test suite in a real environment (npm test) before relying on it",
  };
}

/** True when the step's CURRENT output was produced with the scripted demo defect (first attempt, no repair). */
export function demoDefectActive(step: StepRow): boolean {
  const input = inputOf(step);
  return typeof input.simulateDefect === "string" && step.attempts <= 1 && !input.repair && !input.revisionRepairId;
}

/** Label the finding(s) a demo-injected defect produced and add the explicit demo finding. */
export function labelDemoDefect(step: StepRow, findings: QAFinding[]): QAFinding[] {
  if (!demoDefectActive(step)) return findings;
  const code = DEMO_DEFECT_FINDING[String(inputOf(step).simulateDefect)];
  if (!code || !findings.some((f) => f.code === code)) return findings;
  const labelled = findings.map((f) => (f.code === code && !/simulated defect/i.test(f.message) ? { ...f, message: `${f.message} — simulated defect injected for the demo` } : f));
  return [...labelled, { code: QA_FINDING_CODES.demoInjectedDefect, severity: "minor", message: DEMO_INJECTED_DEFECT_MESSAGE, repairHint: "Handled by the normal repair loop" }];
}

async function loadQaContext(j: JobRow): Promise<QaContext> {
  const db = getDb();
  let brief = `${j.title}\n${j.brief}`;
  let analysis: OpportunityAnalysis | null = null;
  if (j.opportunityId) {
    const [o] = await db.select({ title: opportunity.title, description: opportunity.description }).from(opportunity).where(eq(opportunity.id, j.opportunityId)).limit(1);
    if (o) brief = `${o.title}\n${o.description}`;
    const [a] = await db.select({ analysis: opportunityAnalysis.analysis }).from(opportunityAnalysis).where(eq(opportunityAnalysis.opportunityId, j.opportunityId)).orderBy(desc(opportunityAnalysis.version)).limit(1);
    analysis = a?.analysis ?? null;
  }
  const fromBrief = detectRequestedFeatures(`${brief}\n${analysis?.clientRequest ?? ""}`, j.serviceFamily);
  const fromAnalysis = (analysis?.requestedFeatures ?? []).map((l) => featureByLabel(l)).filter((f): f is FeatureDef => Boolean(f));
  const features = [...new Map([...fromBrief, ...fromAnalysis].map((f) => [f.key, f])).values()];
  return { brief, requiresTests: briefRequiresTests(brief), features: CODE_FAMILIES.includes(j.serviceFamily) ? features : [], analysis };
}

/** Deterministic, provider-independent checks on a step's CURRENT outputs. */
export async function deterministicChecks(deps: AgentDeps, j: JobRow, step: StepRow, qa?: QaContext): Promise<StepCheck> {
  const storage = storageOf(deps);
  const out = outputOf(step);
  const input = inputOf(step);
  const res: StepCheck = { findings: [], failingUnits: [], failingGenerationIds: [], checked: 0, evidence: [], verified: [], notVerified: [] };
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
    const capability = step.capability ?? "image.generate";
    const items = (out.items as { unitIndex: number; globalIndex?: number; generationId: string; assetIds: string[] }[] | undefined) ?? [];
    const contracted = Math.max(0, Math.round(Number(input.deliverableUnits ?? input.units ?? items.length) || 0));
    res.units = [];
    if (!capability.startsWith("image.") && !capability.startsWith("video.")) {
      res.findings.push({
        code: QA_FINDING_CODES.missingFeature,
        severity: "major",
        message: `No connected provider can produce ${capability}; the files in this step are placeholders, not the requested ${capability} deliverable`,
        repairHint: `Connect a provider that offers ${capability} (none is integrated yet) or deliver this part manually`,
      });
      for (const item of items) {
        res.failingUnits.push(item.unitIndex);
        res.failingGenerationIds.push(item.generationId);
      }
    }
    const distinctUnits = new Set(items.map((i) => i.unitIndex)).size;
    if (distinctUnits < contracted) {
      res.findings.push({
        code: QA_FINDING_CODES.deliverableShortfall,
        severity: "major",
        message: `Only ${distinctUnits} of ${contracted} contracted unit${contracted === 1 ? "" : "s"} were produced in ${step.name}`,
        criterion: criterion(step, /count|units|deliverable/i),
        repairHint: `Produce the remaining ${contracted - distinctUnits} unit${contracted - distinctUnits === 1 ? "" : "s"}`,
      });
    } else if (contracted > 0) {
      res.verified!.push(`${step.name}: ${distinctUnits}/${contracted} contracted units produced`);
    }
    for (const item of items) {
      const before = res.findings.length;
      const unit = { unitIndex: item.unitIndex, label: (item.globalIndex ?? item.unitIndex) + 1, generationId: item.generationId, shas: [] as string[], sigs: [] as PerceptualSignature[] };
      for (const id of item.assetIds) {
        const a = byId.get(id) ?? (await assetsById(j.tenantId, [id])).get(id);
        if (!a) {
          res.findings.push({ code: "file_missing", severity: "critical", message: `Asset for #${item.unitIndex + 1} not found`, repairHint: "Regenerate the file" });
          continue;
        }
        const bytes = await load(a);
        if (!bytes) continue;
        res.checked++;
        unit.shas.push(a.sha256);
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
        const sig = perceptualSignature(bytes, a.mime, unzlibSync);
        if (sig) unit.sigs.push(sig);
        const text = a.mime === "image/svg+xml" ? strFromU8(bytes) : null;
        const attrs = text ? svgRootAttributes(text) : {};
        if (attrs["data-kind"] === "storyboard") {
          const fw = Number(attrs["data-frame-width"]);
          const fh = Number(attrs["data-frame-height"]);
          if (ar && !(fw > 0 && fh > 0 && aspectMatches(fw, fh, ar))) {
            res.findings.push({
              code: "aspect_ratio",
              severity: "major",
              message: `Storyboard #${unit.label} frames are ${fw}×${fh} (${describeAspect(fw, fh)}) but the brief requires ${ar}`,
              criterion: criterion(step, /aspect/i),
              repairHint: `Re-frame every shot to ${ar}`,
            });
          }
          res.evidence.push(`#${unit.label} storyboard frames ${fw}×${fh}`);
          continue;
        }
        const info = inspectImage(bytes, a.mime);
        if (!info.width || !info.height) {
          res.findings.push({ code: "unreadable_image", severity: "major", message: `Could not read dimensions of ${a.filename}`, repairHint: "Regenerate in PNG/JPEG/SVG" });
          continue;
        }
        res.evidence.push(`#${unit.label} ${info.format} ${info.width}×${info.height}`);
        if (ar && !aspectMatches(info.width, info.height, ar)) {
          res.findings.push({
            code: "aspect_ratio",
            severity: "major",
            message: `Creative #${unit.label} is ${info.width}×${info.height} (${describeAspect(info.width, info.height)}) but the brief requires ${ar}`,
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
            res.findings.push({ code: "missing_logo_safe_zone", severity: "major", message: `Creative #${unit.label}: logo sits outside the ${margin}px safe zone`, criterion: criterion(step, /logo|safe/i), repairHint: "Move the logo inside the safe zone" });
          }
          if (layout.headline && layout.headline.fontSize > 0) {
            const widest = Math.max(...layout.headline.lines.map((l) => l.length)) * layout.headline.fontSize * GLYPH_ADVANCE;
            if (widest > info.width - margin * 2 + 1) {
              res.findings.push({ code: "text_overflow", severity: "major", message: `Creative #${unit.label}: headline (~${Math.round(widest)}px) overflows the ${info.width - margin * 2}px text area`, criterion: criterion(step, /headline|fit/i), repairHint: "Wrap or shrink the headline to fit" });
            }
          }
        }
      }
      res.units.push(unit);
      if (res.findings.length > before) {
        res.failingUnits.push(item.unitIndex);
        res.failingGenerationIds.push(item.generationId);
      }
    }
    if (items.length === 0) res.findings.push({ code: "no_output", severity: "critical", message: "No creatives were produced", repairHint: "Regenerate the batch" });
    else res.verified!.push(`${step.name}: file formats and ${ar ? `${ar} aspect ratio` : "dimensions"} read from the real file headers`);
    res.findings = labelDemoDefect(step, res.findings);
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
        const artifactFiles: ArtifactFile[] = names.map((n) => ({ path: n.replace(/^project\//, ""), content: files[n]!.byteLength <= 200_000 ? strFromU8(files[n]!) : "" }));
        res.artifact = {
          files: artifactFiles.map((f) => f.path),
          excerpt: artifactFiles
            .filter((f) => !/test-report\.json$|package-lock/.test(f.path))
            .map((f) => `--- ${f.path}\n${truncate(f.content, 400)}`)
            .join("\n")
            .slice(0, 3500),
        };
        // Requested-feature coverage: keyword/structure evidence in SOURCE files (not a functional test).
        if (qa?.features.length) {
          const cov = featureCoverage(qa.features, artifactFiles);
          for (const f of cov.missing) {
            res.findings.push({
              code: QA_FINDING_CODES.missingFeature,
              severity: "major",
              message: `Requested feature not found in the source: ${f.label}`,
              criterion: `Implements: ${f.label}`,
              repairHint: `Implement ${f.label} as the brief requires`,
            });
          }
          if (cov.covered.length) res.verified!.push(`Requested features with evidence in the source (keyword/structure check, not a functional test): ${cov.covered.map((f) => f.label).join(", ")}`);
          for (const f of cov.unverifiable) res.notVerified!.push(`${f.label} (cannot be verified without running the build)`);
        }
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
            message: `${report.failed} self-reported failing test${report.failed === 1 ? "" : "s"}: ${failing.map((t) => `${t.name}${t.error ? ` (${t.error})` : ""}`).join("; ")}`,
            criterion: criterion(step, /tests? pass/i),
            repairHint: `Fix the failing test${report.failed === 1 ? "" : "s"}: ${failing.map((t) => t.name).join(", ")}`,
          });
        }
        // No sandbox runner exists: tests are NEVER executed here, whatever the report claims.
        res.findings.push(testsNotExecuted(qa?.requiresTests));
        res.evidence.push(`${report?.tests?.length ?? 0} tests written, not executed`);
        res.notVerified!.push("Automated tests (written, not executed — no test runner in this environment)");
        res.verified!.push("Source archive opens; README present; no .env file shipped");
        const secretLike = names.find((n) => /(^|\/)\.env$/.test(n));
        if (secretLike) res.findings.push({ code: "secret_file", severity: "critical", message: "Archive contains a .env file", repairHint: "Remove secrets; ship .env.example only" });
      } catch {
        res.findings.push({ code: "corrupt_archive", severity: "critical", message: "Source archive cannot be opened", repairHint: "Re-package the source" });
      }
    }
    res.findings = labelDemoDefect(step, res.findings);
    return res;
  }

  if (step.kind === "test") {
    const report = out.testReport as { failed?: number; passed?: number; simulated?: boolean; tests?: unknown[] } | null | undefined;
    res.checked++;
    if (!report) res.findings.push({ code: "missing_tests", severity: "major", message: "No test results recorded", repairHint: "Run the test suite" });
    else if ((report.failed ?? 0) > 0) res.findings.push({ code: "failing_tests", severity: "major", message: `Test report self-reports ${report.failed} failure(s)`, repairHint: "Fix the failing tests upstream" });
    res.findings.push(testsNotExecuted(qa?.requiresTests));
    res.evidence.push("tests generated but not executed in this environment");
    res.notVerified!.push("Test results (self-reported by the generator; not executed)");
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
    else res.verified!.push(`${step.name}: SRT structure and cue timing parsed (no overlaps)`);
    res.notVerified!.push("Translation quality (no deterministic check; see the model review)");
    res.findings = labelDemoDefect(step, res.findings);
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
    if (/no live web research/i.test(text)) res.notVerified!.push(`${step.name}: no live web research (model knowledge only)`);
  }
  if (docs.length === 0 && step.kind !== "assemble") res.findings.push({ code: "no_output", severity: "critical", message: "No document produced", repairHint: "Write the deliverable" });
  else if (docs.length) res.verified!.push(`${step.name}: required sections present`);
  res.findings = labelDemoDefect(step, res.findings);
  return res;
}

/**
 * Cross-batch uniqueness: every creative unit of the job must be distinct — identical file
 * (sha256) or the same visible content (perceptual signature) is a MAJOR duplicate finding on
 * the later unit (so the repair regenerates only that unit with a different variant).
 */
export function flagDuplicateUnits(targets: { step: StepRow; check: StepCheck }[]): void {
  const seenSha = new Map<string, string>();
  const seenSig: { sig: PerceptualSignature; where: string }[] = [];
  for (const { step, check } of targets) {
    for (const u of check.units ?? []) {
      const where = `${step.name.replace(/ — batch [A-Z]$/, "")} #${u.label}`;
      const shaDup = u.shas.map((s) => seenSha.get(s)).find(Boolean);
      const sigDup = shaDup ? undefined : seenSig.find((x) => u.sigs.some((s) => sameLook(s, x.sig)))?.where;
      const dupOf = shaDup ?? sigDup;
      if (dupOf) {
        check.findings.push({
          code: QA_FINDING_CODES.duplicateDeliverable,
          severity: "major",
          message: `Creative #${u.label} duplicates ${dupOf} (${shaDup ? "identical file" : "same visible content"})`,
          repairHint: "Render a different concept/variant for this unit",
        });
        if (!check.failingUnits.includes(u.unitIndex)) check.failingUnits.push(u.unitIndex);
        if (!check.failingGenerationIds.includes(u.generationId)) check.failingGenerationIds.push(u.generationId);
      }
      for (const s of u.shas) if (!seenSha.has(s)) seenSha.set(s, where);
      for (const sig of u.sigs) seenSig.push({ sig, where });
    }
  }
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
        code: QA_FINDING_CODES.producedByMock,
        severity: "major",
        message: `${failingUnits.length} of ${items.length} creatives were rendered by the mock provider (simulated placeholders, not deliverable work)`,
        repairHint: "Configure a creative provider (and paid spend) so the units can be generated for real",
      });
    }
  } else if (out.provider === "mock") {
    findings.push({
      code: QA_FINDING_CODES.producedByMock,
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
  const minorNotes = check.findings.filter((f) => f.severity === "minor" && f.code !== QA_FINDING_CODES.demoInjectedDefect).map((f) => f.message);
  return {
    verdict: fail ? "fail" : "pass",
    score: Math.round(score * 100) / 100,
    findings: check.findings,
    summary: fail
      ? `${stepName}: ${check.findings.filter((f) => f.severity !== "minor").map((f) => f.message).join("; ")}`
      : `${stepName}: ${check.checked} file${check.checked === 1 ? "" : "s"} checked deterministically — no blocking findings${check.evidence.length ? ` (${check.evidence.slice(0, 3).join(", ")})` : ""}${minorNotes.length ? `; note: ${minorNotes.slice(0, 2).join("; ")}` : ""}`,
  };
}

/** Owner-accepted findings (acceptQaFindings) are kept but downgraded to minor, with the owner's note. */
export function applyAcceptedFindings(findings: QAFinding[], stepKey: string, accepted: AcceptedFinding[]): QAFinding[] {
  if (!accepted.length) return findings;
  return findings.map((f) => {
    const a = accepted.find((x) => x.code === f.code && (!x.stepKey || x.stepKey === stepKey));
    return a && f.severity !== "minor" ? { ...f, severity: "minor" as const, message: `${f.message} — accepted by the owner: ${a.note}` } : f;
  });
}

function reviewIndependence(reviewerFamily: string, reviewerModel: string, producer: { provider: string | null; model: string | null }): ReviewIndependence {
  if (reviewerFamily === "mock") return "deterministic_only";
  if (producer.provider && producer.provider === reviewerFamily && (producer.model === null || producer.model === reviewerModel)) return "same_model";
  return "independent";
}

/**
 * QA Evaluator. For every reviewable upstream step: deterministic checks on the actual files
 * (dimensions from real headers, contracted unit counts, cross-batch duplicates, requested
 * features vs the artifact, required sections, subtitle timing; tests are always flagged as
 * not executed) plus a model review against each acceptance criterion, routed away from the
 * producing model whenever an alternative exists (another family, else gx-mini vs gx-code) and
 * labelled "separate review pass (same model)" when none does. A step fails on any
 * major/critical deterministic finding, or when the model review returns any major/critical
 * finding (regardless of score) or fails it with a low score.
 */
export async function runQaStep(ctx: RunContext, j: JobRow, qaStep: StepRow, all: StepRow[], deps: AgentDeps): Promise<StepOutcome> {
  const db = getDb();
  const upstream = upstreamOf(qaStep, all);
  const targets = all.filter((s) => upstream.has(s.key) && REVIEWABLE_KINDS.has(s.kind) && s.status === "succeeded");
  const reviews: StepReview[] = [];
  const [t] = await db.select({ mode: tenant.mode }).from(tenant).where(eq(tenant.id, j.tenantId)).limit(1);
  const live = t?.mode === "live";
  const qa = await loadQaContext(j);
  const accepted = (Array.isArray(inputOf(qaStep).acceptedFindings) ? (inputOf(qaStep).acceptedFindings as AcceptedFinding[]) : []).filter((a) => a && typeof a.code === "string");

  // 1) Deterministic checks for every target (then cross-batch duplicates across generate steps).
  const checks: { step: StepRow; check: StepCheck }[] = [];
  for (const s of targets) {
    await ctx.checkpoint();
    const check = await deterministicChecks(deps, j, s, qa);
    if (live) {
      const mock = mockProductionFindings(s);
      check.findings.push(...mock.findings);
      for (const u of mock.failingUnits) if (!check.failingUnits.includes(u)) check.failingUnits.push(u);
      for (const g of mock.failingGenerationIds) if (!check.failingGenerationIds.includes(g)) check.failingGenerationIds.push(g);
    }
    checks.push({ step: s, check });
  }
  flagDuplicateUnits(checks.filter((c) => c.step.kind === "generate"));

  // 2) Model review per target + verdict.
  const criteriaBase = [...j.acceptanceCriteria, ...qa.features.map((f) => `Implements: ${f.label}`)];
  for (const { step: s, check } of checks) {
    await ctx.checkpoint();
    check.findings = applyAcceptedFindings(check.findings, s.key, accepted);
    const baseline = deterministicVerdict(check, s.name);
    const producer = {
      provider: typeof outputOf(s).provider === "string" ? (outputOf(s).provider as string) : s.provider,
      model: typeof outputOf(s).model === "string" ? (outputOf(s).model as string) : s.model,
    };
    const producerFamily = producer.provider && INTELLIGENCE_FAMILIES.has(producer.provider) ? producer.provider : null;
    // Prefer a different MODEL: route away from the producing family; if GX is the only family,
    // review heavy (gx-code) output with the fast model and vice versa.
    const task: IntelligenceTask =
      producerFamily === "gx" ? (producer.model === env().GX_MODEL_FAST ? "qa_high" : "qa_basic") : ["code", "test", "copy"].includes(s.kind) ? "qa_high" : "qa_basic";
    const criteria = [...new Set([...s.acceptance, ...(s.kind === "code" || s.kind === "test" ? criteriaBase : j.acceptanceCriteria)])];
    const excerpt =
      check.artifact !== undefined
        ? `Files (${check.artifact.files.length}): ${check.artifact.files.join(", ")}\n${check.artifact.excerpt}`
        : typeof outputOf(s).markdown === "string"
          ? truncate(outputOf(s).markdown as string, 1500)
          : JSON.stringify(outputOf(s).testReport ?? outputOf(s).items ?? {}).slice(0, 1500);
    const llm = await callIntelligence(
      ctx,
      {
        task,
        schema: qaVerdictSchema,
        schemaName: "qa_verdict",
        maxOutputTokens: 900,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are GigPilot's QA evaluator. Judge the work strictly against EACH acceptance criterion using the artifact shown (file list and contents). " +
              "For every criterion or requested feature with no evidence in the artifact, add a MAJOR finding with code \"missing_feature\". " +
              "Do not repeat the deterministic findings listed. Tests cannot be executed in this environment — never claim they passed. " +
              "Return JSON qa_verdict {verdict, score 0..1, findings[{code, severity, message, criterion?, repairHint?}], summary}. Be concise and factual.",
          },
          {
            role: "user",
            content: [
              `Step: ${s.name} (${s.kind})`,
              `Deterministic checks: ${check.findings.length ? check.findings.map((f) => `[${f.severity}] ${f.code}: ${f.message}`).join("; ") : "no findings"} (${check.evidence.slice(0, 6).join(", ")})`,
              wrapUntrusted("job and acceptance criteria", `Job: ${j.title}\nBrief: ${truncate(qa.brief, 1200)}\nAcceptance criteria (check each):\n${criteria.map((c) => `- ${c}`).join("\n") || "- as briefed"}`),
              `Artifact under review:\n${wrapUntrusted("artifact", excerpt)}`,
            ].join("\n"),
          },
        ],
        mockResult: () => baseline,
      },
      { avoidFamilies: producerFamily ? [producerFamily] : undefined },
    );
    const model = llm.data ?? baseline;
    const modelBacked = llm.family !== "mock";
    const modelFindings = modelBacked ? applyAcceptedFindings(model.findings.filter((f) => !check.findings.some((c) => c.code === f.code)), s.key, accepted).slice(0, 6) : [];
    const deterministicFail = baseline.verdict === "fail";
    // Any major/critical model finding fails the step, whatever the score (QA verdict bug fix).
    const blockingModel = modelFindings.filter((f) => f.severity === "major" || f.severity === "critical");
    const llmFail = modelBacked && (blockingModel.length > 0 || (model.verdict === "fail" && model.score < 0.5));
    const verdict: "pass" | "fail" = deterministicFail || llmFail ? "fail" : "pass";
    const findings = [...check.findings, ...modelFindings];
    const score = Math.round(Math.min(baseline.score, modelBacked ? model.score : 1) * 100) / 100;
    const independence = reviewIndependence(llm.family, llm.model, producer);
    const label = INDEPENDENCE_LABEL[independence];
    const summary =
      verdict === "fail"
        ? deterministicFail
          ? baseline.summary
          : `${s.name}: ${blockingModel.map((f) => f.message).join("; ") || model.summary} (${label})`
        : `${baseline.summary} · ${label}${modelBacked ? ` ${llm.family}/${llm.model}` : ""}`;
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
        independence,
        producerProvider: producer.provider,
        producerModel: producer.model,
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
      independence,
      producer,
      verified: check.verified ?? [],
      notVerified: [...(check.notVerified ?? []), ...(modelBacked ? [] : [`${s.name}: no model review (deterministic checks only)`])],
    });
  }

  const failed = reviews.filter((r) => r.verdict === "fail");
  const reviewer = reviews[0]?.reviewer ?? { provider: "mock", model: "mock-deterministic" };
  const independence: ReviewIndependence = reviews.some((r) => r.independence === "same_model") ? "same_model" : reviews.every((r) => r.independence === "deterministic_only") ? "deterministic_only" : "independent";
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
        message: `Repaired ${target ? target.name : "step"} (${r.strategy})${/simulated defect/i.test(r.rationale) ? " — the simulated demo defect is fixed" : ""} — QA re-check now passes (${INDEPENDENCE_LABEL[independence]})`,
      });
    }
    const summary = `QA passed ${reviews.length}/${reviews.length} deliverable checks for ${quote(j.title, 50)} (${INDEPENDENCE_LABEL[independence]}; reviewer ${reviewer.provider}/${reviewer.model})`;
    await emitEvent(db, { tenantId: j.tenantId, type: "qa.passed", level: "success", agent: "qa", runId: ctx.runId, jobId: j.id, subjectType: "job", subjectId: j.id, message: summary, data: { independence, reviews: reviews.map((r) => ({ step: r.stepKey, score: r.score, independence: r.independence })) } });
    return { output: { verdict: "pass", reviews, reviewer, independence, provider: reviewer.provider, model: reviewer.model }, summary, verdict: "pass" };
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
    data: { independence, failed: failed.map((r) => ({ step: r.stepKey, findings: r.findings.map((f) => f.code) })) },
  });
  return { output: { verdict: "fail", reviews, reviewer, independence, provider: reviewer.provider, model: reviewer.model }, summary, verdict: "fail" };
}
