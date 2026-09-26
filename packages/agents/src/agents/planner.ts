import { AGENTS, QUEUES, type OpportunityAnalysis, type QueuePayloads, type WorkflowStepPlan } from "@gigpilot/contracts";
import {
  and,
  costEstimate,
  costLedgerEntry,
  desc,
  eq,
  getDb,
  getTenantSettings,
  job,
  opportunityAnalysis,
  tenant,
  transition,
  workflow,
  workflowStep,
  type EconomicsBreakdown,
} from "@gigpilot/db";
import type { AgentDeps } from "../deps";
import { detectRequestedFeatures } from "../heuristics/features";
import { templateForFamily, type TemplateContext } from "../heuristics/workflows";
import { notify } from "../lib/notify";
import { money, quote, round4 } from "../lib/util";
import { runAgent } from "../runtime";

const PRODUCTION_KIND_BY_FAMILY: Record<string, { kind: string; defect: string }> = {
  "paid-social-ugc": { kind: "generate", defect: "aspect_ratio" },
  "image-design": { kind: "generate", defect: "aspect_ratio" },
  "ai-automation": { kind: "code", defect: "failing_test" },
  "web-app-builds": { kind: "code", defect: "failing_test" },
  "localization-repurposing": { kind: "translate", defect: "srt_overlap" },
  "research-content": { kind: "research", defect: "missing_section" },
};

/** Validates a model-proposed workflow: unique keys, known agents, acyclic deps, a QA step and a production step. */
export function isValidWorkflow(plan: WorkflowStepPlan[] | undefined): plan is WorkflowStepPlan[] {
  if (!plan || plan.length < 2 || plan.length > 20) return false;
  const keys = new Set<string>();
  for (const s of plan) {
    if (!/^[a-z0-9_-]+$/.test(s.key) || keys.has(s.key)) return false;
    if (!(s.agent in AGENTS)) return false;
    for (const d of s.dependsOn) if (!keys.has(d)) return false; // deps must reference earlier steps → acyclic
    keys.add(s.key);
  }
  if (!plan.some((s) => s.agent === "qa")) return false;
  if (!plan.some((s) => ["generate", "code", "copy", "translate", "research"].includes(s.kind))) return false;
  return true;
}

export function templateContextFromAnalysis(analysis: OpportunityAnalysis | null): TemplateContext {
  if (!analysis) return {};
  const creative = analysis.productionEstimates.filter((e) => /^(image|video)\./.test(e.capability));
  const aspect = (label: string) => /(9:16|1:1|4:5|16:9|3:2)/.exec(label)?.[1];
  const ctx: TemplateContext = {};
  if (creative[0]) ctx.primary = { capability: creative[0].capability, label: creative[0].label, aspectRatio: aspect(creative[0].label) };
  if (creative[1]) ctx.secondary = { capability: creative[1].capability, label: creative[1].label, aspectRatio: aspect(creative[1].label) };
  return ctx;
}

function parseLanguages(analysis: OpportunityAnalysis | null, brief: string): string[] {
  const known = ["Spanish", "German", "French", "Italian", "Portuguese", "Japanese", "Korean", "Dutch", "Swedish", "Chinese", "Arabic", "Polish", "Turkish", "Hindi"];
  const text = `${brief} ${analysis?.clientRequest ?? ""} ${analysis?.summary ?? ""}`;
  const found = known.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(text) || (l === "Portuguese" && /PT-BR/i.test(text)));
  return found.length ? found : ["Spanish"];
}

function stepCostShare(step: WorkflowStepPlan, breakdown: EconomicsBreakdown | null, plan: WorkflowStepPlan[]): number {
  if (!breakdown) return 0;
  let total = 0;
  for (const li of breakdown.lineItems) {
    const cost = li.totalUsd ?? 0;
    if (li.category === "creative") {
      const owners = plan.filter((s) => s.estimateLabel === li.label);
      if (owners.some((o) => o.key === step.key)) total += cost / owners.length;
      else if (owners.length === 0 && step.kind === "generate") total += cost / Math.max(1, plan.filter((s) => s.kind === "generate").length);
      continue;
    }
    const label = li.label.toLowerCase();
    const match =
      (/code/.test(label) && step.kind === "code") ||
      (/qa/.test(label) && step.agent === "qa") ||
      (/(hooks|scripts|prompts|art direction)/.test(label) && step.kind === "concepts") ||
      (/research/.test(label) && step.kind === "research") ||
      (/drafting/.test(label) && step.kind === "copy") ||
      (/translation/.test(label) && step.kind === "translate");
    if (match) {
      const peers = plan.filter((s) => s.kind === step.kind || (s.agent === "qa" && step.agent === "qa")).length || 1;
      total += cost / peers;
    }
  }
  return round4(total);
}

type ProductionEstimate = OpportunityAnalysis["productionEstimates"][number];

export interface BatchAssignment {
  /** Units this step must deliver (= generations it renders; ≤ maxGenerationsPerStep). */
  units: number;
  /** Global unit offset across all generate steps of the job (unique concept/variant per unit). */
  unitOffset: number;
  aspectRatio: string;
  estimateLabel: string;
  durationSec?: number;
  batch: { index: number; of: number };
}

function distribute(total: number, parts: number): number[] {
  const n = Math.max(1, parts);
  return Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
}

/**
 * Expand creative batches so every contracted unit is produced exactly once:
 *  - units of an estimate are split per requested aspect ratio (a "16:9 + 9:16" deliverable is
 *    rendered in both formats),
 *  - each batch renders ≤ maxGenerationsPerStep units (extra batches are cloned steps that the
 *    downstream steps also depend on), at least one batch per template owner when there are
 *    enough units (owners without units are dropped),
 *  - every batch gets a global unit offset so batch B renders different concepts/variants than
 *    batch A (never `concepts[i % n]` from zero again).
 */
export function expandCreativeBatches(
  plan: WorkflowStepPlan[],
  estimates: ProductionEstimate[],
  maxPerStep: number,
): { plan: WorkflowStepPlan[]; batches: Map<string, BatchAssignment> } {
  const batches = new Map<string, BatchAssignment>();
  const gen = plan.filter((s) => s.kind === "generate");
  if (gen.length === 0) return { plan, batches };
  const cap = Math.max(1, maxPerStep);
  const estFor = (s: WorkflowStepPlan) => estimates.find((e) => e.label === s.estimateLabel) ?? estimates.find((e) => /^(image|video)\./.test(e.capability));
  // Group owners by the estimate they render (plan order).
  const groups = new Map<string, { est: ProductionEstimate | undefined; owners: WorkflowStepPlan[] }>();
  for (const s of gen) {
    const est = estFor(s);
    const key = est?.label ?? s.estimateLabel ?? s.key;
    const g = groups.get(key) ?? { est, owners: [] };
    g.owners.push(s);
    groups.set(key, g);
  }
  const extra = new Map<string, WorkflowStepPlan[]>(); // original key → cloned batch steps
  const dropped = new Set<string>();
  let offset = 0;
  for (const [label, { est, owners }] of groups) {
    const total = Math.max(0, Math.round(est?.units ?? 4));
    const sourceLabel = est?.label ?? owners[0]!.name;
    const aspects = [...new Set([...sourceLabel.matchAll(/\b(9:16|1:1|4:5|16:9|3:2)\b/g)].map((m) => m[1]!))];
    const fallbackAspect = owners[0]!.capability?.startsWith("video.") ? "9:16" : "1:1";
    const formats = aspects.length ? aspects : [fallbackAspect];
    const perAspect = distribute(total, formats.length);
    const chunks = perAspect.map((c) => (c > 0 ? Math.ceil(c / cap) : 0));
    const wanted = Math.min(owners.length, total);
    while (chunks.reduce((a, b) => a + b, 0) < wanted) {
      // Add a batch to the aspect with the largest units-per-batch until each owner has work.
      let best = -1;
      for (let k = 0; k < perAspect.length; k++) if (perAspect[k]! > chunks[k]! && (best < 0 || perAspect[k]! / chunks[k]! > perAspect[best]! / chunks[best]!)) best = k;
      if (best < 0) break;
      chunks[best]!++;
    }
    const slots: { units: number; aspect: string }[] = [];
    formats.forEach((aspect, k) => {
      for (const units of distribute(perAspect[k]!, chunks[k]!)) if (units > 0) slots.push({ units, aspect });
    });
    const dur = /(\d{1,3})s\b/.exec(sourceLabel)?.[1];
    slots.forEach((slot, idx) => {
      const owner = owners[idx] ?? owners[owners.length - 1]!;
      let key = owner.key;
      if (idx >= owners.length) {
        key = `${owner.key}_${idx - owners.length + 2}`;
        const clone: WorkflowStepPlan = { ...owner, key, name: `${owner.name.replace(/ — batch [A-Z]$/, "")} — batch ${String.fromCharCode(65 + idx)}` };
        extra.set(owner.key, [...(extra.get(owner.key) ?? []), clone]);
      }
      batches.set(key, { units: slot.units, unitOffset: offset, aspectRatio: slot.aspect, estimateLabel: label, ...(dur ? { durationSec: Number(dur) } : {}), batch: { index: idx + 1, of: slots.length } });
      offset += slot.units;
    });
    for (const o of owners.slice(slots.length)) dropped.add(o.key);
  }
  const out: WorkflowStepPlan[] = [];
  for (const s of plan) {
    if (dropped.has(s.key)) continue;
    const clones = extra.get(s.key) ?? [];
    const rewire = (deps: string[]) => [...new Set(deps.flatMap((d) => (dropped.has(d) ? [] : [d, ...(extra.get(d) ?? []).map((c) => c.key)])))];
    out.push({ ...s, dependsOn: rewire(s.dependsOn) });
    for (const c of clones) out.push({ ...c, dependsOn: rewire(c.dependsOn) });
  }
  return { plan: out, batches };
}

/**
 * Production Planner: turns a won job into an executable workflow DAG with
 * per-step capabilities, dependencies, acceptance criteria, estimated cost
 * and attempt limits.
 */
export async function runJobPlan(payload: QueuePayloads["job-plan"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, jobId } = payload;
  const [j] = await db.select().from(job).where(and(eq(job.id, jobId), eq(job.tenantId, tenantId))).limit(1);
  if (!j) return { status: "skipped" as const, reason: "job not found" };
  const [existingWf] = await db.select({ id: workflow.id }).from(workflow).where(and(eq(workflow.jobId, j.id), eq(workflow.status, "active"))).limit(1);
  if (existingWf && j.status !== "intake" && j.status !== "planning") {
    return { status: "skipped" as const, reason: `already planned (${j.status})` };
  }
  if (!["intake", "planning"].includes(j.status)) return { status: "skipped" as const, reason: `job is ${j.status}` };

  const settings = await getTenantSettings(db, tenantId);
  const [t] = await db.select({ mode: tenant.mode }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
  const demo = (t?.mode ?? "demo") === "demo";
  const actor = { type: "agent" as const, id: "planner" };
  if (j.status === "intake") {
    await transition(db, { machine: "job", id: j.id, tenantId, to: "planning", actor, reason: "planning production" });
  }

  return runAgent(
    { deps, tenantId, agent: "planner", task: "plan_production", subjectType: "job", subjectId: j.id, jobId: j.id, label: `Planning ${quote(j.title)}` },
    async (ctx) => {
      const [analysisRow] = j.opportunityId
        ? await db.select().from(opportunityAnalysis).where(eq(opportunityAnalysis.opportunityId, j.opportunityId)).orderBy(desc(opportunityAnalysis.version)).limit(1)
        : [];
      const analysis = analysisRow?.analysis ?? null;
      const [estimate] = j.opportunityId
        ? await db.select().from(costEstimate).where(eq(costEstimate.opportunityId, j.opportunityId)).orderBy(desc(costEstimate.createdAt)).limit(1)
        : [];
      const family = j.serviceFamily;
      const languages = parseLanguages(analysis, j.brief);
      const tmplCtx = { ...templateContextFromAnalysis(analysis), languages };
      const proposed = analysis?.proposedWorkflow;
      const basePlan = isValidWorkflow(proposed) ? proposed : templateForFamily(family, tmplCtx);
      const source = isValidWorkflow(proposed) ? "analysis" : "template";
      const expanded = expandCreativeBatches(basePlan, analysis?.productionEstimates ?? [], settings.limits.maxGenerationsPerStep);
      const plan = expanded.plan;
      // Per-feature acceptance criteria for code deliverables (checked by QA against the artifact).
      const featureLabels = [...new Set([...(analysis?.requestedFeatures ?? []), ...(j.opportunityId ? detectRequestedFeatures(`${j.title}\n${analysis?.clientRequest ?? ""}\n${j.brief}`, family).map((f) => f.label) : [])])];

      let workflowId = existingWf?.id;
      if (!workflowId) {
        const [wf] = await db.insert(workflow).values({ tenantId, jobId: j.id, version: 1, status: "active", plannedBy: "planner" }).returning({ id: workflow.id });
        if (!wf) throw new Error("workflow insert failed");
        workflowId = wf.id;
      }
      const existingSteps = await db.select({ key: workflowStep.key }).from(workflowStep).where(eq(workflowStep.workflowId, workflowId));
      const existingKeys = new Set(existingSteps.map((s) => s.key));

      // Demo workspaces only (never live), and only when the tenant keeps demo.injectDefect on.
      const defectTarget = demo && settings.demo.injectDefect ? PRODUCTION_KIND_BY_FAMILY[family] : undefined;
      const defectStepKey = defectTarget ? plan.find((s) => s.kind === defectTarget.kind)?.key : undefined;
      const estimates = analysis?.productionEstimates ?? [];
      const translateSteps = plan.filter((s) => s.kind === "translate");
      const sourceItems = (() => {
        const n = estimates.find((e) => e.capability === "text.translate");
        return n ? Math.max(1, Math.round(n.units / Math.max(1, languages.length))) : 3;
      })();

      let estimatedTotal = 0;
      for (const [position, s] of plan.entries()) {
        if (existingKeys.has(s.key)) continue;
        const input: Record<string, unknown> = { family, source };
        if (s.kind === "generate") {
          const b = expanded.batches.get(s.key);
          input.units = b?.units ?? 1;
          input.deliverableUnits = b?.units ?? 1;
          input.unitOffset = b?.unitOffset ?? 0;
          input.batch = b?.batch ?? { index: 1, of: 1 };
          input.aspectRatio = b?.aspectRatio ?? (s.capability?.startsWith("video.") ? "9:16" : "1:1");
          if (b?.durationSec) input.durationSec = b.durationSec;
          input.estimateLabel = b?.estimateLabel ?? s.estimateLabel ?? s.name;
        }
        if (s.kind === "translate") {
          const idx = translateSteps.findIndex((x) => x.key === s.key);
          const half = Math.ceil(languages.length / Math.max(1, translateSteps.length));
          input.languages = languages.slice(idx * half, idx * half + half);
          input.sourceItems = Math.min(4, sourceItems);
          input.deliverableSourceItems = sourceItems;
        }
        if (defectStepKey === s.key && defectTarget) {
          input.simulateDefect = defectTarget.defect;
          input.demoDefect = true; // labelled everywhere: QA finding demo_injected_defect, repair + delivery notes
        }
        const acceptance = (s.kind === "code" || s.kind === "test") && featureLabels.length ? [...s.acceptance, ...featureLabels.map((f) => `Implements: ${f}`)] : s.acceptance;
        const estimatedCostUsd = stepCostShare(s, estimate?.breakdown ?? null, plan);
        estimatedTotal += estimatedCostUsd;
        await db.insert(workflowStep).values({
          tenantId,
          workflowId,
          jobId: j.id,
          key: s.key,
          name: s.name,
          kind: s.kind,
          agent: s.agent,
          capability: s.capability ?? null,
          dependsOn: s.dependsOn,
          status: "pending",
          attempts: 0,
          maxAttempts: s.agent === "qa" ? settings.limits.maxRepairsPerJob + 1 : settings.limits.maxStepAttempts,
          estimatedCostUsd,
          acceptance,
          input,
          position,
        });
      }

      // Production cost estimates in the ledger (estimate vs actual on the Costs page).
      const [hasEstimates] = await db
        .select({ id: costLedgerEntry.id })
        .from(costLedgerEntry)
        .where(and(eq(costLedgerEntry.jobId, j.id), eq(costLedgerEntry.kind, "estimate"), eq(costLedgerEntry.category, "creative")))
        .limit(1);
      if (!hasEstimates && estimate?.breakdown) {
        const b = estimate.breakdown;
        const creative = b.lineItems.filter((l) => l.category === "creative").reduce((a, l) => a + (l.totalUsd ?? 0), 0);
        const inference = b.lineItems.filter((l) => l.category === "inference").reduce((a, l) => a + (l.totalUsd ?? 0), 0);
        await db.insert(costLedgerEntry).values([
          { tenantId, jobId: j.id, opportunityId: j.opportunityId, category: "creative", kind: "estimate", amountUsd: round4(creative), memo: "Planned creative production (catalog prices)" },
          { tenantId, jobId: j.id, opportunityId: j.opportunityId, category: "inference", kind: "estimate", amountUsd: round4(inference), memo: "Planned inference (catalog prices)" },
          { tenantId, jobId: j.id, opportunityId: j.opportunityId, category: "human_shadow", kind: "estimate", amountUsd: round4(b.shadowCostUsd), memo: "Owner review & coordination time (shadow rate)" },
        ]);
      }

      const needsInputs = !demo && (analysis?.missingInputs.length ?? 0) > 0;
      const to = needsInputs ? "awaiting_inputs" : "ready";
      // Incomplete economics (e.g. an unpriced capability): plan anyway, but tell the owner the
      // estimate — and therefore the job's spend limit — excludes the unknown items.
      const incomplete = estimate ? !estimate.complete : false;
      const missing = estimate?.breakdown?.missing ?? [];
      const message = `Planned ${plan.length}-step workflow for ${quote(j.title)} (${source}) — est. production ${money(estimatedTotal)}${incomplete ? " (incomplete estimate)" : ""}, spend limit ${money(j.spendLimitUsd)}`;
      await transition(db, {
        machine: "job",
        id: j.id,
        tenantId,
        to,
        actor,
        reason: needsInputs ? `waiting for: ${analysis!.missingInputs.join("; ")}` : "workflow planned",
        event: { type: "workflow.planned", level: incomplete ? "warn" : "info", agent: "planner", runId: ctx.runId, subjectType: "job", subjectId: j.id, jobId: j.id, message, data: { steps: plan.map((s) => s.key), source, estimateComplete: !incomplete, missing } },
      });
      if (incomplete) {
        await notify(db, {
          tenantId,
          kind: "alert",
          title: `Incomplete cost estimate for “${j.title.slice(0, 70)}”`,
          body: `The production estimate excludes: ${missing.slice(0, 4).join("; ") || "some unpriced items"}. The spend limit (${money(j.spendLimitUsd)}) may be too low — raise it on the job page if a step is blocked by the budget.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `job-estimate-incomplete:${j.id}`,
        });
      }
      if (needsInputs) {
        await notify(db, {
          tenantId,
          kind: "approval",
          title: `Inputs needed for “${j.title.slice(0, 80)}”`,
          body: `Production is waiting for: ${analysis!.missingInputs.join("; ")}. Confirm on the job page once the client has supplied them.`,
          link: `/jobs/${j.id}`,
          dedupeKey: `job-inputs:${j.id}`,
        });
      } else {
        await deps.queue.send(QUEUES.workflowTick, { tenantId, jobId: j.id }, { singletonKey: j.id });
      }
      ctx.summary = message;
      return { status: "planned" as const, workflowId, steps: plan.length, to };
    },
  );
}
