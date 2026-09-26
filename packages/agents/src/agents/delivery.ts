import { strToU8, zipSync } from "fflate";
import type { QueuePayloads } from "@gigpilot/contracts";
import {
  and,
  asset,
  costLedgerEntry,
  delivery,
  desc,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  inArray,
  job,
  opportunityAnalysis,
  qaReview,
  repair,
  revision,
  transition,
  type DeliveryManifest,
} from "@gigpilot/db";
import { storageOf, type AgentDeps } from "../deps";
import { isQaStep } from "../heuristics/workflows";
import { notify } from "../lib/notify";
import { money, quote, round4, slugify } from "../lib/util";
import { runAgent, storeFile, type AssetRow, type StepRow } from "../runtime";
import { draftDeliveryNotes } from "./client";
import { clientNameOf } from "./execution";
import { loadActiveSteps } from "./orchestrator";

function outputOf(s: StepRow): Record<string, unknown> {
  return (s.output ?? {}) as Record<string, unknown>;
}

function stepAssetIds(s: StepRow): string[] {
  const refs = (outputOf(s).assets as { assetId: string }[] | undefined) ?? [];
  return refs.map((r) => r.assetId).filter(Boolean);
}

/**
 * Delivery packaging (Media Finishing + Client agents). Zips every final
 * asset with MANIFEST.md, DELIVERY-NOTES.md (drafted, never sent) and a QA
 * summary, stores it as an archive asset, records actual-vs-estimated cost,
 * and parks the job for the owner's final approval.
 */
export async function runDeliveryPrepare(payload: QueuePayloads["delivery-prepare"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, jobId } = payload;
  const [j] = await db.select().from(job).where(and(eq(job.id, jobId), eq(job.tenantId, tenantId))).limit(1);
  if (!j) return { status: "skipped" as const, reason: "job not found" };
  if (!["executing", "qa", "repairing"].includes(j.status)) return { status: "skipped" as const, reason: `job is ${j.status}` };
  const steps = await loadActiveSteps(tenantId, jobId);
  if (steps.length === 0 || !steps.every((s) => s.status === "succeeded" || s.status === "skipped")) {
    return { status: "skipped" as const, reason: "workflow not complete" };
  }
  const [existing] = await db
    .select()
    .from(delivery)
    .where(and(eq(delivery.jobId, j.id), inArray(delivery.status, ["preparing", "prepared"])))
    .orderBy(desc(delivery.createdAt))
    .limit(1);
  if (existing?.status === "prepared") return { status: "skipped" as const, reason: "already prepared" };
  const settings = await getTenantSettings(db, tenantId);

  return runAgent(
    { deps, tenantId, agent: "finisher", task: "delivery.package", subjectType: "job", subjectId: j.id, jobId: j.id, label: `Delivery package for ${quote(j.title)}` },
    async (ctx) => {
      let deliveryId = existing?.id;
      if (!deliveryId) {
        const [d] = await db.insert(delivery).values({ tenantId, jobId: j.id, status: "preparing" }).returning({ id: delivery.id });
        deliveryId = d!.id;
      }
      const storage = storageOf(deps);
      const finals = steps.filter((s) => !isQaStep(s));
      const ids = finals.flatMap(stepAssetIds);
      const rows = ids.length ? await db.select().from(asset).where(and(eq(asset.tenantId, tenantId), inArray(asset.id, ids))) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));

      const files: Record<string, Uint8Array> = {};
      const manifestItems: DeliveryManifest["items"] = [];
      const listing: { filename: string; description?: string }[] = [];
      for (const [idx, s] of finals.entries()) {
        const folder = `${String(idx + 1).padStart(2, "0")}-${slugify(s.key, 24)}`;
        for (const id of stepAssetIds(s)) {
          const a = byId.get(id) as AssetRow | undefined;
          if (!a) continue;
          const bytes = await storage.get(a.storageKey);
          let name = `${folder}/${a.filename}`;
          let n = 2;
          while (files[name]) name = `${folder}/${n++}-${a.filename}`;
          files[name] = bytes;
          manifestItems.push({ assetId: a.id, filename: name, kind: a.kind, bytes: a.bytes, description: s.name });
          listing.push({ filename: name, description: s.name });
        }
      }

      const reviews = await db.select().from(qaReview).where(eq(qaReview.jobId, j.id)).orderBy(desc(qaReview.createdAt));
      const latestByStep = new Map<string, (typeof reviews)[number]>();
      for (const r of reviews) if (r.stepId && !latestByStep.has(r.stepId)) latestByStep.set(r.stepId, r);
      const repairs = await db.select().from(repair).where(eq(repair.jobId, j.id));
      const doneRepairs = repairs.filter((r) => r.status === "succeeded");
      const passed = [...latestByStep.values()].filter((r) => r.verdict === "pass").length;
      const qaSummary = `${passed}/${latestByStep.size} deliverable checks passed independent QA${doneRepairs.length ? `, ${doneRepairs.length} repair${doneRepairs.length === 1 ? "" : "s"} applied` : ""}`;

      const [analysisRow] = j.opportunityId
        ? await db.select({ analysis: opportunityAnalysis.analysis }).from(opportunityAnalysis).where(eq(opportunityAnalysis.opportunityId, j.opportunityId)).orderBy(desc(opportunityAnalysis.version)).limit(1)
        : [];
      const clientName = await clientNameOf(j);
      const notes = await draftDeliveryNotes(ctx, { job: j, clientName, files: listing, qaSummary, repairs: doneRepairs.length, analysis: analysisRow?.analysis ?? null });

      const [fresh] = await db.select({ actual: job.actualCostUsd, estimated: job.estimatedCostUsd }).from(job).where(eq(job.id, j.id)).limit(1);
      const actual = Number(fresh?.actual ?? 0);
      const estimated = Number(fresh?.estimated ?? j.estimatedCostUsd);
      const variance = estimated > 0 ? (actual - estimated) / estimated : null;

      const manifestMd = [
        `# Manifest — ${j.title}`,
        "",
        `Prepared by GigPilot on ${new Date().toISOString().slice(0, 10)}.`,
        "",
        "| File | Kind | Size | From step |",
        "|---|---|---|---|",
        ...manifestItems.map((m) => `| ${m.filename} | ${m.kind} | ${(m.bytes / 1024).toFixed(1)} KB | ${m.description ?? ""} |`),
        "",
        "## Production cost",
        `Actual ${money(actual)} vs estimated ${money(estimated)}${variance !== null ? ` (${variance >= 0 ? "+" : ""}${Math.round(variance * 100)}%)` : ""}. Mock-mode costs are simulated at catalog prices.`,
      ].join("\n");
      const qaMd = [
        `# QA summary — ${j.title}`,
        "",
        qaSummary,
        "",
        ...[...latestByStep.values()].map((r) => {
          const step = steps.find((s) => s.id === r.stepId);
          return `- **${step?.name ?? "Step"}** — ${r.verdict.toUpperCase()} (score ${r.score.toFixed(2)}, reviewer ${r.provider ?? "?"}/${r.model ?? "?"}): ${r.summary}`;
        }),
        ...(repairs.length ? ["", "## Repairs", ...repairs.map((r) => `- ${r.strategy} (${r.status}): ${r.rationale}`)] : []),
      ].join("\n");
      files["MANIFEST.md"] = strToU8(manifestMd);
      files["DELIVERY-NOTES.md"] = strToU8(`# ${notes.subject}\n\n${notes.message}\n\n---\nDraft prepared by GigPilot's Client Agent — not sent. Review before sharing.\n`);
      files["QA-SUMMARY.md"] = strToU8(qaMd);

      const zip = zipSync(files, { level: 6 });
      const pkg = await storeFile(deps, db, {
        tenantId,
        jobId: j.id,
        stepId: null,
        filename: `${slugify(j.title, 48)}-delivery.zip`,
        mime: "application/zip",
        bytes: zip,
        kind: "archive",
        meta: { deliveryId, files: Object.keys(files).length },
      });

      const manifest: DeliveryManifest = { items: manifestItems, notes: notes.message, qaSummary };
      const actor = { type: "agent" as const, id: "finisher" };
      await db.transaction(async (tx) => {
        await transition(tx, {
          machine: "delivery",
          id: deliveryId!,
          tenantId,
          to: "prepared",
          actor,
          patch: { packageAssetId: pkg.id, manifest, clientMessage: notes.message },
          event: {
            type: "delivery.prepared",
            level: "success",
            agent: "finisher",
            runId: ctx.runId,
            subjectType: "delivery",
            subjectId: deliveryId!,
            jobId: j.id,
            message: `Delivery package ready for ${quote(j.title)} — ${manifestItems.length} files, ${qaSummary}`,
          },
        });
        const [cur] = await tx.select({ status: job.status }).from(job).where(eq(job.id, j.id)).limit(1);
        if (cur?.status === "executing" || cur?.status === "repairing") {
          await transition(tx, { machine: "job", id: j.id, tenantId, to: "qa", actor, reason: "all steps passed" });
        }
        await transition(tx, {
          machine: "job",
          id: j.id,
          tenantId,
          to: "awaiting_final_approval",
          actor,
          reason: "delivery package prepared",
          event: { type: "job.state", level: "success", agent: "orchestrator", runId: ctx.runId, subjectType: "job", subjectId: j.id, jobId: j.id, message: `${quote(j.title)} is awaiting your final approval` },
        });
        await tx.insert(costLedgerEntry).values({
          tenantId,
          jobId: j.id,
          opportunityId: j.opportunityId,
          category: "tool",
          kind: "actual",
          amountUsd: 0,
          agentRunId: ctx.runId,
          memo: `Production total: actual ${money(actual)} vs estimated ${money(estimated)}${variance !== null ? ` (${variance >= 0 ? "+" : ""}${Math.round(variance * 100)}%)` : ""}`,
        });
        await emitEvent(tx, {
          tenantId,
          type: "cost.recorded",
          level: "info",
          agent: "economics",
          runId: ctx.runId,
          jobId: j.id,
          subjectType: "job",
          subjectId: j.id,
          message: `Production cost for ${quote(j.title, 50)}: ${money(actual)} actual vs ${money(estimated)} estimated${variance !== null ? ` (${variance >= 0 ? "+" : ""}${Math.round(variance * 100)}%)` : ""}`,
          data: { actualUsd: round4(actual), estimatedUsd: round4(estimated), variance },
        });
        await tx.update(revision).set({ status: "done" }).where(and(eq(revision.jobId, j.id), eq(revision.status, "planned")));
        await tx.update(repair).set({ status: "succeeded" }).where(and(eq(repair.jobId, j.id), eq(repair.status, "running")));
      });
      await notify(db, {
        tenantId,
        kind: "approval",
        title: `Final delivery ready: “${j.title.slice(0, 80)}”`,
        body: `${manifestItems.length} files · ${qaSummary}. Review the package and approve to mark it delivered.`,
        link: `/jobs/${j.id}`,
        dedupeKey: `delivery-approve:${deliveryId}`,
      });

      if (!settings.autonomy.requireFinalDeliveryApproval) {
        await db.transaction(async (tx) => {
          await transition(tx, { machine: "delivery", id: deliveryId!, tenantId, to: "approved", actor: { type: "system", id: "autonomy" }, patch: { approvedAt: new Date() }, reason: "final approval not required by tenant autonomy settings" });
          await transition(tx, { machine: "job", id: j.id, tenantId, to: "delivered", actor: { type: "system", id: "autonomy" }, patch: { completedAt: new Date() } });
        });
      }
      ctx.summary = `Packaged ${manifestItems.length} files (${(zip.byteLength / 1024).toFixed(0)} KB)`;
      return { status: "prepared" as const, deliveryId, packageAssetId: pkg.id, files: manifestItems.length };
    },
  );
}
