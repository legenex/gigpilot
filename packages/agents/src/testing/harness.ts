import "./setup";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resetEnvCache } from "@gigpilot/config";
import type { QueueName, TenantSettingsInput } from "@gigpilot/contracts";
import { bootstrapTenantForUser, eq, getDb, sql, tenant, user } from "@gigpilot/db";
// Test-only deep imports (these helpers are intentionally not part of the packages' public API).
import { runMigrations } from "../../../db/src/migrate";
import { createCreativeBroker } from "../../../providers/src/broker";
import { MockIntelligenceProvider } from "../../../providers/src/intelligence/mock";
import { createIntelligenceRouter } from "../../../providers/src/router";
import { RecordingQueue, silentLogger, type AgentDeps, type RecordedJob } from "../deps";
import { handlers } from "../handlers";
import type { CommandContext } from "../commands";
import { repoRoot } from "./setup";

let migrated = false;

export async function migrateTestDb(): Promise<void> {
  if (migrated) return;
  await runMigrations(path.join(repoRoot(), "packages/db/migrations"));
  migrated = true;
}

/** Truncate every application table (keeps the drizzle migration journal). */
export async function resetDb(): Promise<void> {
  const db = getDb();
  const rows = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { tablename: string }[];
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}

export interface TestTenant {
  tenantId: string;
  userId: string;
  ctx: CommandContext;
}

export async function createTestTenant(opts: { mode?: "demo" | "live"; settings?: TenantSettingsInput } = {}): Promise<TestTenant> {
  const db = getDb();
  const userId = `user_${randomUUID().slice(0, 12)}`;
  await db.insert(user).values({ id: userId, name: "Test Owner", email: `${userId}@example.test`, emailVerified: true });
  const { tenantId } = await bootstrapTenantForUser(db, { userId, name: "Test Owner", email: `${userId}@example.test`, mode: opts.mode ?? "demo" });
  if (opts.settings) {
    const [t] = await db.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)).limit(1);
    const merged = deepMerge((t?.settings ?? {}) as Record<string, unknown>, opts.settings as Record<string, unknown>);
    await db.update(tenant).set({ settings: merged }).where(eq(tenant.id, tenantId));
  }
  return { tenantId, userId, ctx: { tenantId, userId, role: "owner" } };
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

interface BossGlobal {
  __gigpilotBoss?: Promise<unknown>;
}

/** Route commands' enqueue() (via getProducer) into a recording queue instead of pg-boss. */
export function captureCommandQueue(queue: RecordingQueue): void {
  (globalThis as unknown as BossGlobal).__gigpilotBoss = Promise.resolve({
    send: (name: string, data: object, options?: object) => queue.send(name as QueueName, data as never, options ?? {}),
  });
}

export function testDeps(overrides: Partial<AgentDeps> = {}): AgentDeps & { queue: RecordingQueue } {
  resetEnvCache();
  const queue = (overrides.queue as RecordingQueue | undefined) ?? new RecordingQueue();
  return {
    log: silentLogger,
    now: () => new Date(),
    router: createIntelligenceRouter([new MockIntelligenceProvider()]),
    broker: createCreativeBroker(),
    ...overrides,
    queue,
  };
}

export interface DrainOptions {
  /** Queues left in the recording queue instead of being executed. */
  hold?: QueueName[];
  max?: number;
  onJob?: (job: RecordedJob, result: unknown) => void;
}

/** Execute queued follow-up work FIFO until the queue is empty (deterministic in-process worker). */
export async function drain(deps: AgentDeps & { queue: RecordingQueue }, opts: DrainOptions = {}): Promise<RecordedJob[]> {
  const ran: RecordedJob[] = [];
  const held: RecordedJob[] = [];
  const max = opts.max ?? 500;
  for (let i = 0; i < max; i++) {
    const job = deps.queue.shift();
    if (!job) break;
    if (opts.hold?.includes(job.name)) {
      held.push(job);
      continue;
    }
    const handler = handlers[job.name] as (p: unknown, d: AgentDeps) => Promise<unknown>;
    const result = await handler(job.payload, deps);
    opts.onJob?.(job, result);
    ran.push(job);
  }
  for (const h of held) await deps.queue.send(h.name, h.payload as never, h.options);
  return ran;
}

export interface BriefInput {
  title: string;
  description: string;
  budgetMinUsd: number;
  budgetMaxUsd: number;
  budgetType?: "fixed" | "hourly";
  sourceKey?: string;
}

export const AUTOMATION_BRIEF: BriefInput = {
  title: "Shopify → HubSpot order & customer sync in n8n",
  description:
    "We need a reliable Shopify → HubSpot sync built in our self-hosted n8n. Sync orders, customers and line items to HubSpot contacts and deals in near real time. " +
    "Requirements: webhook triggers, dedupe contacts by email, retry with backoff on 429s, Slack alert on failures, README + runbook. Access to a staging store and HubSpot sandbox provided. Deliver in 10 days.",
  budgetMinUsd: 2400,
  budgetMaxUsd: 2400,
};

export const IMAGE_BRIEF: BriefInput = {
  title: "25 product images: white-background cleanup + lifestyle composites",
  description:
    "We sell ceramic homeware on Shopify and need 25 product images: white-background cleanup for 15 SKUs plus 10 lifestyle composites. " +
    "Output: 2048×2048 PNG/JPG, consistent soft shadows, colour-accurate. We supply the raw photos (RAW + JPG) and 5 mood references. Deadline 7 days.",
  budgetMinUsd: 800,
  budgetMaxUsd: 900,
};

/**
 * Test oracle: can the deterministic (mock-mode) pipeline honestly deliver this brief? Code briefs
 * qualify only when the deterministic generator covers every requested feature and the brief does
 * not require tests (tests can never be executed here → QA escalates to the owner, by design).
 */
export async function mockCanDeliver(o: { title: string; description: string; marketKey: string | null; clientName?: string | null }): Promise<boolean> {
  const { briefRequiresTests, detectRequestedFeatures, featureCoverage } = await import("../heuristics/features");
  const { generateAutomationArtifact, generateWebArtifact } = await import("../heuristics/code");
  const family = o.marketKey ?? "";
  if (family !== "web-app-builds" && family !== "ai-automation") return true;
  const text = `${o.title}\n${o.description}`;
  if (briefRequiresTests(text)) return false;
  const art =
    family === "web-app-builds"
      ? generateWebArtifact({ title: o.title, brief: o.description, clientName: o.clientName ?? null, defect: null, repairHint: null })
      : generateAutomationArtifact({ title: o.title, brief: o.description, defect: null, repairHint: null });
  return featureCoverage(detectRequestedFeatures(text, family), art.files).missing.length === 0;
}

let briefSeq = 0;

/** Insert an opportunity as the scout would (status new). */
export async function insertOpportunity(t: TestTenant, b: BriefInput): Promise<string> {
  const { opportunity } = await import("@gigpilot/db");
  const { dedupeHash } = await import("@gigpilot/economics");
  const [row] = await getDb()
    .insert(opportunity)
    .values({
      tenantId: t.tenantId,
      sourceKey: b.sourceKey ?? "mock",
      externalId: `test-${++briefSeq}-${Date.now()}`,
      title: b.title,
      description: b.description,
      clientName: "Harbor & Pine Outfitters",
      clientCountry: "United States",
      clientRating: 4.8,
      clientSpendUsd: 42000,
      budgetType: b.budgetType ?? "fixed",
      budgetMinUsd: b.budgetMinUsd,
      budgetMaxUsd: b.budgetMaxUsd,
      postedAt: new Date(),
      deadlineAt: new Date(Date.now() + 14 * 86_400_000),
      dedupeHash: dedupeHash(b.title, b.description),
      status: "new",
    })
    .returning({ id: opportunity.id });
  return row!.id;
}

/** Analyse → approve → proposal → approve; returns the approved application (submission NOT yet run). */
export async function approvedApplication(t: TestTenant, deps: AgentDeps & { queue: RecordingQueue }, oppId: string): Promise<string> {
  const { approveOpportunity, approveProposal } = await import("../commands");
  const { and: andOp, proposal: proposalTable } = await import("@gigpilot/db");
  captureCommandQueue(deps.queue);
  await handlers["opportunity-analyse"]({ tenantId: t.tenantId, opportunityId: oppId }, deps);
  await approveOpportunity(t.ctx, oppId);
  await drain(deps);
  const [prop] = await getDb()
    .select()
    .from(proposalTable)
    .where(andOp(eq(proposalTable.opportunityId, oppId), eq(proposalTable.status, "awaiting_approval")))
    .limit(1);
  const { applicationId } = await approveProposal(t.ctx, prop!.id);
  deps.queue.take("application-submit");
  return applicationId;
}

/** Full path up to a won job (job-plan left queued unless `plan` is true). */
export async function wonJob(t: TestTenant, deps: AgentDeps & { queue: RecordingQueue }, brief: BriefInput, opts: { plan?: boolean } = {}): Promise<string> {
  const { job: jobTable } = await import("@gigpilot/db");
  const oppId = await insertOpportunity(t, brief);
  const applicationId = await approvedApplication(t, deps, oppId);
  await handlers["application-submit"]({ tenantId: t.tenantId, applicationId }, deps);
  await drain(deps, { hold: ["job-plan"] });
  const [j] = await getDb().select({ id: jobTable.id }).from(jobTable).where(eq(jobTable.opportunityId, oppId)).limit(1);
  if (opts.plan) {
    deps.queue.take("job-plan");
    await handlers["job-plan"]({ tenantId: t.tenantId, jobId: j!.id }, deps);
  }
  return j!.id;
}
