import { QUEUES, type QueuePayloads } from "@gigpilot/contracts";
import {
  and,
  application,
  emitEvent,
  eq,
  getDb,
  getTenantSettings,
  idempotencyKey,
  opportunity,
  proposal,
  sql,
  transition,
} from "@gigpilot/db";
import { createJobFromApplication } from "../domain/jobs";
import { sourceOf, type AgentDeps } from "../deps";
import { forTenant, isConfiguredFor } from "../lib/adapters";
import { notify } from "../lib/notify";
import { fnv, money, quote, safeError } from "../lib/util";
import { runAgent } from "../runtime";

/** In-flight submissions younger than this are treated as running elsewhere (never double-submit). */
const IN_FLIGHT_MS = 5 * 60_000;

export interface SubmitResult {
  status: "submitted" | "manual_required" | "skipped" | "in_flight" | "ambiguous";
  detail: string;
  externalRef?: string;
}

/**
 * Application submission. Idempotent twice over: the application row's
 * unique idempotency key, plus an idempotency_key ledger row claimed in a
 * row-locked transaction before any external call. Only marketplaces that
 * officially permit programmatic submission (adapter.canSubmit) are used,
 * and only after the owner approved the proposal; everything else becomes a
 * "submit this manually" task.
 */
export async function runApplicationSubmit(payload: QueuePayloads["application-submit"], deps: AgentDeps): Promise<SubmitResult> {
  const db = getDb();
  const { tenantId, applicationId } = payload;
  const [app] = await db.select().from(application).where(and(eq(application.id, applicationId), eq(application.tenantId, tenantId))).limit(1);
  if (!app) return { status: "skipped", detail: "application not found" };
  if (app.status !== "approved") return { status: "skipped", detail: `application is ${app.status}` };
  const [opp] = await db.select().from(opportunity).where(eq(opportunity.id, app.opportunityId)).limit(1);
  if (!opp) return { status: "skipped", detail: "opportunity missing" };
  const [prop] = app.proposalId ? await db.select().from(proposal).where(eq(proposal.id, app.proposalId)).limit(1) : [];
  const settings = await getTenantSettings(db, tenantId);
  const baseAdapter = sourceOf(deps, opp.sourceKey);
  // Bind the tenant so submit()/health() use the tenant's own marketplace credentials.
  const adapter = baseAdapter ? forTenant(baseAdapter, tenantId) : undefined;
  const configured = adapter ? await isConfiguredFor(adapter, tenantId) : false;
  const canAuto = Boolean(adapter?.capabilities.canSubmit && adapter.submit && configured && settings.autonomy.autoSubmitWhenPermitted);

  if (!canAuto || !adapter?.submit) {
    const marketplace = adapter?.name ?? opp.sourceKey;
    const reason = !adapter?.capabilities.canSubmit
      ? `${marketplace} does not permit programmatic submission`
      : !configured
        ? `${marketplace} is not connected`
        : "auto-submit is turned off in Settings";
    await emitEvent(db, {
      tenantId,
      type: "application.manual_submission_required",
      level: "warn",
      agent: "client",
      subjectType: "application",
      subjectId: app.id,
      message: `Submit ${quote(opp.title)} on ${marketplace} yourself — ${reason}. The approved proposal is ready to paste.`,
    });
    await notify(db, {
      tenantId,
      kind: "approval",
      title: `Submit this proposal on ${marketplace}`,
      body: `${opp.title} — ${money(app.priceUsd ?? prop?.priceUsd ?? 0)}. ${reason}. Mark it submitted once done.`,
      link: `/applications?application=${app.id}`,
      dedupeKey: `manual-submit:${app.id}`,
    });
    return { status: "manual_required", detail: reason };
  }

  const key = `submit:${tenantId}:${app.idempotencyKey}`;
  const claimOnce = () => db.transaction(async (tx) => {
    // Serialise every worker on this submission key, then lock the application row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    await tx.execute(sql`select id from ${application} where id = ${app.id} for update`);
    const [cur] = await tx.select({ status: application.status }).from(application).where(eq(application.id, app.id)).limit(1);
    if (cur?.status !== "approved") return { kind: "done" as const, detail: `application is ${cur?.status}` };
    const inserted = await tx
      .insert(idempotencyKey)
      .values({ key, tenantId, scope: "application.submit", result: null })
      .onConflictDoNothing()
      .returning({ key: idempotencyKey.key });
    if (inserted.length > 0) return { kind: "claimed" as const };
    const [existing] = await tx.select().from(idempotencyKey).where(eq(idempotencyKey.key, key)).limit(1);
    if (existing?.result) return { kind: "done" as const, detail: "already submitted" };
    const age = existing ? Date.now() - existing.createdAt.getTime() : 0;
    if (age < IN_FLIGHT_MS) return { kind: "in_flight" as const };
    return { kind: "stale" as const };
  });
  let claim: Awaited<ReturnType<typeof claimOnce>>;
  try {
    claim = await claimOnce();
  } catch (err) {
    // A deadlock (40P01) is safe to retry: the claim transaction rolled back with no side effects.
    if ((err as { code?: string; cause?: { code?: string } }).code !== "40P01" && (err as { cause?: { code?: string } }).cause?.code !== "40P01") throw err;
    claim = await claimOnce();
  }

  if (claim.kind === "done") return { status: "skipped", detail: claim.detail };
  if (claim.kind === "in_flight") return { status: "in_flight", detail: "another worker is submitting this application" };
  if (claim.kind === "stale" && adapter.key !== "mock") {
    await notify(db, {
      tenantId,
      kind: "alert",
      title: `Check submission status on ${adapter.name}`,
      body: `A previous submission attempt for “${opp.title.slice(0, 80)}” was interrupted. Verify on ${adapter.name} before retrying — GigPilot will not resubmit automatically.`,
      link: `/applications?application=${app.id}`,
      dedupeKey: `ambiguous-submit:${app.id}`,
    });
    return { status: "ambiguous", detail: "previous attempt interrupted; owner must verify" };
  }

  return runAgent(
    { deps, tenantId, agent: "client", task: "application.submit", subjectType: "application", subjectId: app.id, idempotencyKey: key, label: `Submission of ${quote(opp.title)}` },
    async (ctx) => {
      const result = await adapter.submit!({
        externalOpportunityId: opp.externalId,
        coverLetter: prop?.coverLetter ?? "",
        amountUsd: app.priceUsd ?? prop?.priceUsd ?? 0,
        periodDays: prop?.timelineDays ?? 7,
        idempotencyKey: app.idempotencyKey,
      });
      if (result.status !== "submitted") {
        await db.update(idempotencyKey).set({ result: { status: result.status, detail: result.detail } }).where(eq(idempotencyKey.key, key));
        await notify(db, {
          tenantId,
          kind: "alert",
          title: `${adapter.name} did not accept the submission`,
          body: `${opp.title}: ${safeError(result.detail, 300)}`,
          link: `/applications?application=${app.id}`,
          dedupeKey: `submit-rejected:${app.id}`,
        });
        ctx.summary = `Submission ${result.status}: ${result.detail}`;
        return { status: "manual_required" as const, detail: result.detail };
      }
      const mode = adapter.key === "mock" ? "mock" : "api";
      await db.transaction(async (tx) => {
        // Same lock order as the claim (advisory lock → application row → idempotency row);
        // without it a concurrent claim holding the row lock deadlocks against this update.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        await tx.execute(sql`select id from ${application} where id = ${app.id} for update`);
        await tx.update(idempotencyKey).set({ result: { status: "submitted", externalRef: result.externalRef ?? null } }).where(eq(idempotencyKey.key, key));
        await transition(tx, {
          machine: "application",
          id: app.id,
          tenantId,
          to: "submitted",
          actor: { type: "agent", id: "client" },
          reason: "owner-approved proposal submitted via official integration",
          patch: { submittedAt: new Date(), submissionMode: mode, externalRef: result.externalRef ?? null },
          event: {
            type: "application.submitted",
            level: "success",
            agent: "client",
            runId: ctx.runId,
            subjectType: "application",
            subjectId: app.id,
            message: `Submitted ${quote(opp.title)} to ${adapter.name} at ${money(app.priceUsd ?? prop?.priceUsd ?? 0)}${mode === "mock" ? " (demo marketplace)" : ""}`,
          },
        });
        if (opp.status === "pursuing") {
          await transition(tx, { machine: "opportunity", id: opp.id, tenantId, to: "applied", actor: { type: "agent", id: "client" } });
        }
      });
      if (adapter.key === "mock") {
        // The demo client "reviews" the proposal and accepts after a short, deterministic delay.
        const delay = 15 + (fnv(app.id) % 11);
        await deps.queue.send(QUEUES.applicationAward, { tenantId, applicationId: app.id }, { singletonKey: app.id, startAfter: delay });
      }
      ctx.summary = `Submitted to ${adapter.name}${result.externalRef ? ` (${result.externalRef})` : ""}`;
      return { status: "submitted" as const, detail: result.detail, externalRef: result.externalRef };
    },
  );
}

/** Demo marketplace only: the simulated client awards the job. */
export async function runApplicationAward(payload: QueuePayloads["application-award"], deps: AgentDeps) {
  const db = getDb();
  const { tenantId, applicationId } = payload;
  const [app] = await db.select().from(application).where(and(eq(application.id, applicationId), eq(application.tenantId, tenantId))).limit(1);
  if (!app) return { status: "skipped" as const, reason: "not found" };
  const [opp] = await db.select().from(opportunity).where(eq(opportunity.id, app.opportunityId)).limit(1);
  if (!opp || opp.sourceKey !== "mock") return { status: "skipped" as const, reason: "awards are only simulated for the demo marketplace" };
  if (!["submitted", "client_response", "negotiating", "won"].includes(app.status)) return { status: "skipped" as const, reason: `application is ${app.status}` };

  const { jobId, created } = await db.transaction((tx) =>
    createJobFromApplication(tx, { tenantId, applicationId: app.id, actor: { type: "system", id: "demo-marketplace" } }),
  );
  if (created) {
    await emitEvent(db, {
      tenantId,
      type: "system",
      level: "info",
      agent: "client",
      subjectType: "job",
      subjectId: jobId,
      jobId,
      message: `Demo client ${opp.clientName ?? ""} accepted the proposal — planning production`.replace(/\s+/g, " "),
    });
  }
  await deps.queue.send(QUEUES.jobPlan, { tenantId, jobId }, { singletonKey: jobId });
  return { status: created ? ("awarded" as const) : ("already_awarded" as const), jobId };
}
