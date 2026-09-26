import type { Capability } from "@gigpilot/contracts";
import { and, delivery, emitEvent, eq, getDb, inArray, job, repair, revision, sql, transition, workflowStep, type Executor } from "@gigpilot/db";
import { brokerOf, type AgentDeps } from "../deps";
import { isQaStep, PRODUCTION_KINDS } from "../heuristics/workflows";
import { configuredCreativeProviders } from "../lib/adapters";
import { notify } from "../lib/notify";
import { money, quote, round4, truncate } from "../lib/util";
import { computeBudget, runAgent, type JobRow, type StepRow } from "../runtime";
import type { RepairDirective } from "./execution";
import { loadActiveSteps } from "./orchestrator";
import type { StepReview } from "./qa";

type Strategy = "repair" | "regenerate" | "reroute";

const LAYOUT_DEFECTS = new Set(["aspect_ratio", "missing_logo_safe_zone", "text_overflow"]);
const INTELLIGENCE_FAMILIES = new Set(["gx", "factory", "grok"]);

function outputOf(s: StepRow): Record<string, unknown> {
  return (s.output ?? {}) as Record<string, unknown>;
}

export function chooseStrategy(step: StepRow, codes: string[], previousRepairs: number): Strategy {
  if (step.kind === "generate") {
    if (step.capability?.startsWith("video.")) return previousRepairs === 0 ? "regenerate" : "reroute";
    if (previousRepairs === 0 && codes.length > 0 && codes.every((c) => LAYOUT_DEFECTS.has(c))) return "repair";
    return previousRepairs <= 1 ? "reroute" : "regenerate";
  }
  if (step.kind === "code") return previousRepairs === 0 ? "regenerate" : "reroute";
  return previousRepairs === 0 ? "repair" : "reroute";
}

/** All steps that (transitively) depend on `key`. */
export function dependentsOf(key: string, all: StepRow[]): StepRow[] {
  const out = new Map<string, StepRow>();
  const walk = (k: string) => {
    for (const s of all) {
      if (s.dependsOn.includes(k) && !out.has(s.key)) {
        out.set(s.key, s);
        walk(s.key);
      }
    }
  };
  walk(key);
  return [...out.values()];
}

async function reopen(db: Executor, tenantId: string, step: StepRow, patch: Record<string, unknown>, reason: string) {
  const actor = { type: "agent" as const, id: "recovery" };
  const [cur] = await db.select({ status: workflowStep.status }).from(workflowStep).where(eq(workflowStep.id, step.id)).limit(1);
  if (cur?.status === "ready") {
    await db.update(workflowStep).set(patch).where(eq(workflowStep.id, step.id));
    return;
  }
  await transition(db, { machine: "step", id: step.id, tenantId, to: "ready", actor, reason, patch });
}

async function blockDownstream(db: Executor, tenantId: string, target: StepRow, all: StepRow[], reason: string) {
  const actor = { type: "agent" as const, id: "recovery" };
  for (const d of dependentsOf(target.key, all)) {
    const [cur] = await db.select({ status: workflowStep.status }).from(workflowStep).where(eq(workflowStep.id, d.id)).limit(1);
    const status = cur?.status;
    if (status === "succeeded") {
      await transition(db, { machine: "step", id: d.id, tenantId, to: "ready", actor, reason });
      await transition(db, { machine: "step", id: d.id, tenantId, to: "blocked", actor, reason: `waiting for ${target.name}` });
    } else if (status === "failed" || status === "ready") {
      await transition(db, { machine: "step", id: d.id, tenantId, to: "blocked", actor, reason: `waiting for ${target.name}` });
    }
  }
}

async function estimateRepairCost(deps: AgentDeps, j: JobRow, step: StepRow, strategy: Strategy, units: number, budget: Awaited<ReturnType<typeof computeBudget>>, settings: { qualityThreshold: number; preference: string[] }) {
  if (step.kind !== "generate") return 0; // text/code repairs run on local GX or mock at $0 unless paid inference is enabled
  const capability = (strategy === "repair" && step.capability === "image.generate" ? "image.edit" : step.capability ?? "image.generate") as Capability;
  const input = (step.input ?? {}) as Record<string, unknown>;
  const durationSec = typeof input.durationSec === "number" ? input.durationSec : undefined;
  const broker = brokerOf(deps);
  const configuredProviders = await configuredCreativeProviders(broker, j.tenantId);
  const plan = broker.plan(capability, { tenantId: j.tenantId, budget, qualityThreshold: settings.qualityThreshold, preference: settings.preference, durationSec, configuredProviders } as never);
  const unit = plan.option.unitCostUsd ?? 0;
  const perUnit = plan.option.unit === "second" ? unit * (durationSec ?? 8) : unit;
  return round4(perUnit * Math.max(1, units));
}

/**
 * Recovery Agent. Diagnoses the smallest failing component from the QA
 * review, picks a strategy (image-edit repair, regenerate, or reroute to
 * another provider/model), prices the increment from the catalog and checks
 * repair/attempt/spend limits. Within limits it records a repair, re-opens
 * the step as a new attempt (history is preserved) and blocks dependents
 * until the repaired output is re-checked by a fresh, independent QA run.
 * Beyond limits it escalates to the owner.
 */
export async function recoverFromQaFailure(input: { tenantId: string; jobId: string; qaStepId: string; parentRunId: string | null }, deps: AgentDeps) {
  const db = getDb();
  const [j] = await db.select().from(job).where(and(eq(job.id, input.jobId), eq(job.tenantId, input.tenantId))).limit(1);
  if (!j) return { repairs: 0, escalated: 0 };
  const all = await loadActiveSteps(input.tenantId, input.jobId);
  const qaStep = all.find((s) => s.id === input.qaStepId);
  if (!qaStep) return { repairs: 0, escalated: 0 };
  const failing = ((outputOf(qaStep).reviews as StepReview[] | undefined) ?? []).filter((r) => r.verdict === "fail");

  return runAgent(
    { deps, tenantId: input.tenantId, agent: "recovery", task: "recovery", subjectType: "job", subjectId: j.id, jobId: j.id, parentRunId: input.parentRunId, label: `Recovery for ${quote(j.title)}` },
    async (ctx) => {
      const settings = await ctx.settings();
      const actor = { type: "agent" as const, id: "recovery" };
      if (j.status === "qa") {
        await transition(db, {
          machine: "job",
          id: j.id,
          tenantId: j.tenantId,
          to: "repairing",
          actor,
          reason: "QA found defects",
          event: { type: "job.state", level: "warn", agent: "recovery", runId: ctx.runId, subjectType: "job", subjectId: j.id, jobId: j.id, message: `QA found ${failing.length} issue${failing.length === 1 ? "" : "s"} on ${quote(j.title)} — Recovery Agent is repairing` },
        });
      }
      // Repairs that were in flight for steps that failed again did not work.
      const failingStepIds = failing.map((f) => f.stepId);
      if (failingStepIds.length) {
        await db.update(repair).set({ status: "failed" }).where(and(eq(repair.jobId, j.id), eq(repair.status, "running"), inArray(repair.stepId, failingStepIds)));
      }

      const budget = await computeBudget(db, j.tenantId, settings, { jobId: j.id });
      const [fresh] = await db.select({ repairCount: job.repairCount, spendLimitUsd: job.spendLimitUsd, actualCostUsd: job.actualCostUsd }).from(job).where(eq(job.id, j.id)).limit(1);
      let repairCount = fresh?.repairCount ?? j.repairCount;
      let remainingSpend = Number(fresh?.spendLimitUsd ?? j.spendLimitUsd) - Number(fresh?.actualCostUsd ?? j.actualCostUsd);
      let repairs = 0;
      let escalated = 0;
      const notes: string[] = [];

      // Handle root causes first; a failure downstream of a step already being repaired
      // (e.g. a test report that reflects a broken implementation) is re-checked after that repair.
      const ordered = [...failing].sort((a, b) => (all.find((s) => s.id === a.stepId)?.position ?? 0) - (all.find((s) => s.id === b.stepId)?.position ?? 0));
      const covered = new Set<string>();
      for (const review of ordered) {
        const target = all.find((s) => s.id === review.stepId);
        if (!target) continue;
        if (covered.has(target.key)) {
          notes.push(`${target.name} re-checked after upstream repair`);
          continue;
        }
        for (const d of dependentsOf(target.key, all)) covered.add(d.key);
        const codes = review.findings.filter((f) => f.severity !== "minor").map((f) => f.code);
        const [{ n } = { n: 0 }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(repair)
          .where(and(eq(repair.jobId, j.id), eq(repair.stepId, target.id), inArray(repair.strategy, ["repair", "regenerate", "reroute"])));
        const strategy = chooseStrategy(target, codes, n);
        const units = review.failingUnits.length || 1;
        const incremental = await estimateRepairCost(deps, j, target, strategy, units, budget, {
          qualityThreshold: settings.routing.creativeQualityThreshold,
          preference: settings.routing.creativeProviderPreference,
        });
        const hint = review.findings
          .map((f) => f.repairHint)
          .filter(Boolean)
          .slice(0, 3)
          .join("; ");
        const label = review.failingUnits.length ? `${target.name} (${review.failingUnits.map((u) => `#${u + 1}`).join(", ")})` : target.name;

        const limit =
          !settings.autonomy.autoRepairWithinLimits
            ? "auto-repair is disabled in Settings"
            : repairCount >= settings.limits.maxRepairsPerJob
              ? `repair limit reached (${settings.limits.maxRepairsPerJob} per job)`
              : target.attempts >= target.maxAttempts
                ? `${target.name} has used all ${target.maxAttempts} attempts`
                : incremental > remainingSpend + 1e-9
                  ? `repair would cost ${money(incremental)} but only ${money(Math.max(0, remainingSpend))} of the job's spend limit remains`
                  : null;

        if (limit) {
          escalated++;
          await db.insert(repair).values({
            tenantId: j.tenantId,
            jobId: j.id,
            qaReviewId: review.reviewId,
            stepId: target.id,
            strategy: "escalate",
            rationale: `${codes.join(", ") || "qa failure"} on ${label}: ${limit}`,
            incrementalCostUsd: incremental,
            status: "blocked",
            attempt: n + 1,
          });
          await emitEvent(db, {
            tenantId: j.tenantId,
            type: "repair.limit_reached",
            level: "warn",
            agent: "recovery",
            runId: ctx.runId,
            jobId: j.id,
            subjectType: "step",
            subjectId: target.id,
            message: `Cannot auto-repair ${label}: ${limit} — waiting for the owner`,
          });
          await notify(db, {
            tenantId: j.tenantId,
            kind: "alert",
            title: `Repair needs your decision on “${j.title.slice(0, 70)}”`,
            body: `${label}: ${review.findings[0]?.message ?? "QA failure"}. ${limit}.`,
            link: `/jobs/${j.id}`,
            dedupeKey: `repair-limit:${j.id}:${target.id}:${repairCount}`,
          });
          notes.push(`escalated ${label}`);
          continue;
        }

        const items = (outputOf(target).items as { unitIndex: number; provider: string; model: string }[] | undefined) ?? [];
        const failingItems = items.filter((i) => review.failingUnits.includes(i.unitIndex));
        const exclude = strategy === "reroute" ? failingItems.filter((i) => i.provider !== "mock").map((i) => ({ provider: i.provider, model: i.model })) : undefined;
        const producer = typeof outputOf(target).provider === "string" ? (outputOf(target).provider as string) : target.provider;
        const avoidFamilies = strategy === "reroute" && producer && INTELLIGENCE_FAMILIES.has(producer) ? [producer] : undefined;
        const rationale =
          strategy === "repair" && target.kind === "generate"
            ? `${codes.join(", ")} on ${label} → targeted image edit (cheapest fix; other units kept)`
            : strategy === "repair"
              ? `${codes.join(", ")} on ${label} → revise the document with QA feedback`
              : strategy === "regenerate"
                ? `${codes.join(", ")} on ${label} → regenerate${target.kind === "generate" ? " only the failing units" : ""} with the QA hint`
                : `${codes.join(", ")} on ${label} persisted → reroute to a different provider/model`;

        const [row] = await db
          .insert(repair)
          .values({
            tenantId: j.tenantId,
            jobId: j.id,
            qaReviewId: review.reviewId,
            stepId: target.id,
            strategy,
            rationale,
            incrementalCostUsd: incremental,
            status: "running",
            attempt: n + 1,
          })
          .returning({ id: repair.id });
        const directive: RepairDirective = {
          repairId: row!.id,
          strategy,
          hint: hint || review.findings[0]?.message || "Fix the QA findings",
          unitIndexes: review.failingUnits.length ? review.failingUnits : undefined,
          generationIds: review.failingGenerationIds.length ? review.failingGenerationIds : undefined,
          exclude,
          avoidFamilies,
        };
        await reopen(db, j.tenantId, target, { input: { ...((target.input ?? {}) as Record<string, unknown>), repair: directive } }, `repair: ${strategy}`);
        await blockDownstream(db, j.tenantId, target, all, `re-check after repairing ${target.name}`);
        repairCount++;
        remainingSpend -= incremental;
        repairs++;
        await emitEvent(db, {
          tenantId: j.tenantId,
          type: "repair.started",
          level: "info",
          agent: "recovery",
          runId: ctx.runId,
          jobId: j.id,
          subjectType: "step",
          subjectId: target.id,
          message: `Repairing ${label}: ${truncate(review.findings[0]?.message ?? codes.join(", "), 140)} → ${strategy}${incremental > 0 ? ` (+${money(incremental)}${budget.allowPaid ? "" : " simulated"})` : ""}`,
          data: { strategy, incrementalCostUsd: incremental, units: review.failingUnits },
        });
        notes.push(`${strategy} ${label}`);
      }

      if (repairs > 0) {
        await db.update(job).set({ repairCount }).where(eq(job.id, j.id));
        const [qaNow] = await db.select({ status: workflowStep.status }).from(workflowStep).where(eq(workflowStep.id, qaStep.id)).limit(1);
        if (qaNow?.status === "failed") {
          await transition(db, { machine: "step", id: qaStep.id, tenantId: j.tenantId, to: "blocked", actor, reason: "waiting for repairs before re-checking" });
        }
      }
      ctx.summary = notes.length ? notes.join("; ") : "no repairable findings";
      return { repairs, escalated };
    },
  );
}

/**
 * Owner-requested changes after final review: reject the prepared package,
 * re-open the final production step with the owner's note, and let the
 * normal QA → delivery loop run again. Revisions do not count against the
 * automatic repair limit.
 */
export async function handleRevisionRequest(
  input: { tenantId: string; job: JobRow; revisionRow: typeof revision.$inferSelect; steps: StepRow[] },
  deps: AgentDeps,
) {
  const db = getDb();
  const { job: j, revisionRow, steps } = input;
  const production = steps.filter((s) => PRODUCTION_KINDS.has(s.kind) && !isQaStep(s));
  const target = production[production.length - 1];
  if (!target) return;
  await runAgent(
    { deps, tenantId: j.tenantId, agent: "recovery", task: "revision", subjectType: "job", subjectId: j.id, jobId: j.id, label: `Revision for ${quote(j.title)}` },
    async (ctx) => {
      const prepared = await db.select({ id: delivery.id }).from(delivery).where(and(eq(delivery.jobId, j.id), eq(delivery.status, "prepared")));
      for (const d of prepared) {
        await transition(db, { machine: "delivery", id: d.id, tenantId: j.tenantId, to: "rejected", actor: { type: "agent", id: "recovery" }, reason: "owner requested changes" });
      }
      const [row] = await db
        .insert(repair)
        .values({ tenantId: j.tenantId, jobId: j.id, stepId: target.id, strategy: "repair", rationale: `Owner requested changes: “${truncate(revisionRow.request, 200)}”`, incrementalCostUsd: 0, status: "running", attempt: 1 })
        .returning({ id: repair.id });
      const baseInput = { ...((target.input ?? {}) as Record<string, unknown>) };
      delete baseInput.repair;
      await reopen(db, j.tenantId, target, { input: { ...baseInput, revisionNote: revisionRow.request, revisionRepairId: row!.id } }, "owner revision");
      await blockDownstream(db, j.tenantId, target, steps, `re-check after revising ${target.name}`);
      await db
        .update(revision)
        .set({ status: "planned", interpretation: `Re-opened “${target.name}” with the owner's note; QA and packaging will re-run.`, inScope: true })
        .where(eq(revision.id, revisionRow.id));
      await emitEvent(db, {
        tenantId: j.tenantId,
        type: "repair.started",
        level: "info",
        agent: "recovery",
        runId: ctx.runId,
        jobId: j.id,
        subjectType: "step",
        subjectId: target.id,
        message: `Reworking ${target.name} for ${quote(j.title, 50)} per owner feedback`,
      });
      ctx.summary = `Re-opened ${target.name} for revision`;
    },
  );
}
