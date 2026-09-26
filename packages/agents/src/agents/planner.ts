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
      const plan = isValidWorkflow(proposed) ? proposed : templateForFamily(family, tmplCtx);
      const source = isValidWorkflow(proposed) ? "analysis" : "template";

      let workflowId = existingWf?.id;
      if (!workflowId) {
        const [wf] = await db.insert(workflow).values({ tenantId, jobId: j.id, version: 1, status: "active", plannedBy: "planner" }).returning({ id: workflow.id });
        if (!wf) throw new Error("workflow insert failed");
        workflowId = wf.id;
      }
      const existingSteps = await db.select({ key: workflowStep.key }).from(workflowStep).where(eq(workflowStep.workflowId, workflowId));
      const existingKeys = new Set(existingSteps.map((s) => s.key));

      const defectTarget = demo ? PRODUCTION_KIND_BY_FAMILY[family] : undefined;
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
          const est = estimates.find((e) => e.label === s.estimateLabel) ?? estimates.find((e) => /^(image|video)\./.test(e.capability));
          const owners = plan.filter((p) => p.kind === "generate" && (p.estimateLabel ?? "") === (s.estimateLabel ?? ""));
          const idx = owners.findIndex((o) => o.key === s.key);
          const total = est?.units ?? 4;
          const share = owners.length > 1 ? (idx === 0 ? Math.ceil(total / owners.length) : Math.floor(total / owners.length)) : total;
          input.units = Math.max(1, Math.min(settings.limits.maxGenerationsPerStep, share));
          input.deliverableUnits = share;
          input.aspectRatio = /(9:16|1:1|4:5|16:9|3:2)/.exec(est?.label ?? s.name)?.[1] ?? (s.capability?.startsWith("video.") ? "9:16" : "1:1");
          const dur = /(\d{1,3})s\)/.exec(est?.label ?? "")?.[1];
          if (dur) input.durationSec = Number(dur);
          input.estimateLabel = est?.label ?? s.estimateLabel ?? s.name;
        }
        if (s.kind === "translate") {
          const idx = translateSteps.findIndex((x) => x.key === s.key);
          const half = Math.ceil(languages.length / Math.max(1, translateSteps.length));
          input.languages = languages.slice(idx * half, idx * half + half);
          input.sourceItems = Math.min(4, sourceItems);
          input.deliverableSourceItems = sourceItems;
        }
        if (defectStepKey === s.key && defectTarget) input.simulateDefect = defectTarget.defect;
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
          acceptance: s.acceptance,
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
      const message = `Planned ${plan.length}-step workflow for ${quote(j.title)} (${source}) — est. production ${money(estimatedTotal)}, spend limit ${money(j.spendLimitUsd)}`;
      await transition(db, {
        machine: "job",
        id: j.id,
        tenantId,
        to,
        actor,
        reason: needsInputs ? `waiting for: ${analysis!.missingInputs.join("; ")}` : "workflow planned",
        event: { type: "workflow.planned", level: "info", agent: "planner", runId: ctx.runId, subjectType: "job", subjectId: j.id, jobId: j.id, message, data: { steps: plan.map((s) => s.key), source } },
      });
      if (needsInputs) {
        await notify(db, {
          tenantId,
          kind: "approval",
          title: `Inputs needed for “${j.title.slice(0, 80)}”`,
          body: `Production is waiting for: ${analysis!.missingInputs.join("; ")}.`,
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
