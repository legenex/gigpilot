import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ApplicationState,
  DeliveryState,
  JobState,
  OpportunityAnalysis,
  OpportunityState,
  ProposalState,
  QAFinding,
  RunState,
  StepState,
  TenantSettingsInput,
  IntegrationStatus,
  MarketInsight,
} from "@gigpilot/contracts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const usd = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

// ---------------------------------------------------------------------------
// Auth (Better Auth core tables — property names must match Better Auth fields)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/** Better Auth database-backed rate limiter storage. */
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: numeric("last_request", { mode: "number" }).notNull(),
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenant = pgTable("tenant", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** "demo" workspaces run mock sources; "live" workspaces use configured integrations. */
  mode: text("mode").$type<"demo" | "live">().notNull().default("demo"),
  settings: jsonb("settings").$type<TenantSettingsInput>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "admin" | "member">().notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_tenant_user_uq").on(t.tenantId, t.userId), index("membership_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Markets & sources
// ---------------------------------------------------------------------------

export interface MarketMetrics {
  opportunitiesPerDay: number;
  avgBudgetUsd: number;
  avgMargin: number;
  avgProfitUsd: number;
  competition: number; // 0..1 (higher = more competitive)
  winRate: number; // 0..1
  fulfilmentReliability: number; // 0..1
  avgTurnaroundDays: number;
  demandTrend: "up" | "down" | "flat";
}

export const market = pgTable(
  "market",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    allocationPct: doublePrecision("allocation_pct").notNull().default(0),
    recommendedAllocationPct: doublePrecision("recommended_allocation_pct"),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    metrics: jsonb("metrics").$type<MarketMetrics>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("market_tenant_key_uq").on(t.tenantId, t.key)],
);

export const marketInsight = pgTable(
  "market_insight",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    body: jsonb("body").$type<MarketInsight>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("market_insight_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const sourceIntegration = pgTable(
  "source_integration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Non-secret configuration (queries, feed URLs, filters). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<IntegrationStatus>().notNull().default("needs_configuration"),
    statusDetail: text("status_detail"),
    lastSyncAt: ts("last_sync_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("source_integration_tenant_key_uq").on(t.tenantId, t.sourceKey)],
);

export const providerIntegration = pgTable(
  "provider_integration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    kind: text("kind").$type<"intelligence" | "creative" | "marketplace" | "orchestration">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<IntegrationStatus>().notNull().default("needs_configuration"),
    statusDetail: text("status_detail"),
    latencyMs: integer("latency_ms"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    lastCheckAt: ts("last_check_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_integration_tenant_key_uq").on(t.tenantId, t.providerKey)],
);

/** Per-tenant provider credentials, AES-256-GCM encrypted at rest. Never returned to clients. */
export const providerSecret = pgTable(
  "provider_secret",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    /** Last 4 chars for display, e.g. "••••a1b2". */
    hint: text("hint").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_secret_uq").on(t.tenantId, t.providerKey, t.name)],
);

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const opportunity = pgTable(
  "opportunity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    clientName: text("client_name"),
    clientCountry: text("client_country"),
    clientRating: doublePrecision("client_rating"),
    clientSpendUsd: usd("client_spend_usd"),
    budgetType: text("budget_type").$type<"fixed" | "hourly" | "unknown">().notNull().default("unknown"),
    budgetMinUsd: usd("budget_min_usd"),
    budgetMaxUsd: usd("budget_max_usd"),
    currency: text("currency").notNull().default("USD"),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    marketKey: text("market_key"),
    proposalsCount: integer("proposals_count"),
    postedAt: ts("posted_at"),
    deadlineAt: ts("deadline_at"),
    expiresAt: ts("expires_at"),
    status: text("status").$type<OpportunityState>().notNull().default("new"),
    /** Normalised content hash for cross-source duplicate detection. */
    dedupeHash: text("dedupe_hash").notNull(),
    duplicateOfId: uuid("duplicate_of_id"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    // denormalised latest analysis summary for fast radar queries
    expectedProfitUsd: usd("expected_profit_usd"),
    expectedMargin: doublePrecision("expected_margin"),
    estimatedCostUsd: usd("estimated_cost_usd"),
    expectedFeesUsd: usd("expected_fees_usd"),
    priceUsd: usd("price_usd"),
    overallScore: doublePrecision("overall_score"),
    recommendation: text("recommendation").$type<"pursue" | "consider" | "skip">(),
    estimateComplete: boolean("estimate_complete"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("opportunity_source_uq").on(t.tenantId, t.sourceKey, t.externalId),
    index("opportunity_tenant_status_idx").on(t.tenantId, t.status),
    index("opportunity_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("opportunity_dedupe_idx").on(t.tenantId, t.dedupeHash),
  ],
);

export const opportunityAnalysis = pgTable(
  "opportunity_analysis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunity.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    analysis: jsonb("analysis").$type<OpportunityAnalysis>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
  },
  // One row per (opportunity, version): concurrent analyses retry with the next version.
  (t) => [uniqueIndex("opportunity_analysis_opp_version_uq").on(t.opportunityId, t.version)],
);

export interface CostLineItem {
  category: "creative" | "inference" | "tool" | "subcontractor";
  label: string;
  provider: string | null;
  model: string | null;
  unit: string;
  unitCostUsd: number | null;
  quantity: number;
  attempts: number;
  totalUsd: number | null;
  priceSource: string;
  /**
   * Whether the priced route actually runs for this tenant today (absent on estimates
   * written before 2026-09-27): "available" = configured and affordable; "local" = local
   * compute/tooling at $0; "simulated" = no connected provider, priced at the catalog route
   * the mock renderer simulates; "unavailable" = no provider can run it (estimate incomplete).
   */
  routeStatus?: "available" | "local" | "simulated" | "unavailable";
  /** Family/provider the analysis asked for when the priced route was substituted (e.g. "factory"). */
  requestedProvider?: string | null;
  /** Short human-readable routing note, e.g. "factory not configured → priced on gx (local, $0)". */
  routeNote?: string;
  /** Capability this line prices (production lines). */
  capability?: string;
}

/** How each production unit type of the analysis is covered by the estimate. */
export interface CostCoverageItem {
  label: string;
  capability: string;
  units: number;
  /** "inference" = delivered by model calls, priced via the inference lines ("priced via inference"). */
  pricedVia: "creative" | "inference" | "local" | "unpriced";
  provider: string | null;
  model: string | null;
  routeStatus: "available" | "local" | "simulated" | "unavailable";
  note?: string;
}

export interface EconomicsBreakdown {
  priceUsd: number;
  priceBasis: "fixed_budget" | "hourly_estimate" | "proposal" | "unknown";
  lineItems: CostLineItem[];
  fulfilmentCostUsd: number;
  revisionContingencyUsd: number;
  contingencyUsd: number;
  shadowCostUsd: number;
  platformFeesUsd: number;
  platformFeeKey: string;
  totalCostUsd: number;
  grossProfitUsd: number;
  grossMargin: number;
  breakEvenPriceUsd: number;
  complete: boolean;
  missing: string[];
  /** Per production unit type: how it is priced and whether its route runs (absent on older rows). */
  coverage?: CostCoverageItem[];
}

export interface ScoreGates {
  budget: { pass: boolean; value: number | null; threshold: number; soft: true };
  profit: { pass: boolean; value: number; threshold: number };
  margin: { pass: boolean; value: number; threshold: number };
  complete: { pass: boolean };
}

export const costEstimate = pgTable(
  "cost_estimate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunity.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    analysisId: uuid("analysis_id").references(() => opportunityAnalysis.id, { onDelete: "set null" }),
    breakdown: jsonb("breakdown").$type<EconomicsBreakdown>().notNull(),
    totalCostUsd: usd("total_cost_usd").notNull(),
    grossProfitUsd: usd("gross_profit_usd").notNull(),
    grossMargin: doublePrecision("gross_margin").notNull(),
    complete: boolean("complete").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("cost_estimate_opp_idx").on(t.opportunityId), index("cost_estimate_job_idx").on(t.jobId)],
);

export const opportunityScore = pgTable(
  "opportunity_score",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunity.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id").references(() => opportunityAnalysis.id, { onDelete: "set null" }),
    costEstimateId: uuid("cost_estimate_id").references(() => costEstimate.id, { onDelete: "set null" }),
    fit: doublePrecision("fit").notNull(),
    complexity: doublePrecision("complexity").notNull(),
    revisionRisk: doublePrecision("revision_risk").notNull(),
    deadlineRisk: doublePrecision("deadline_risk").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    overall: doublePrecision("overall").notNull(),
    recommendation: text("recommendation").$type<"pursue" | "consider" | "skip">().notNull(),
    gates: jsonb("gates").$type<ScoreGates>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("opportunity_score_opp_idx").on(t.opportunityId)],
);

// ---------------------------------------------------------------------------
// Proposals, applications, clients
// ---------------------------------------------------------------------------

export const proposal = pgTable(
  "proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunity.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    headline: text("headline").notNull(),
    coverLetter: text("cover_letter").notNull(),
    scope: jsonb("scope").$type<{ item: string; detail?: string }[]>().notNull().default([]),
    priceUsd: usd("price_usd").notNull(),
    timelineDays: integer("timeline_days").notNull(),
    assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
    questions: jsonb("questions").$type<string[]>().notNull().default([]),
    status: text("status").$type<ProposalState>().notNull().default("draft"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    agentRunId: uuid("agent_run_id"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("proposal_opp_idx").on(t.opportunityId)],
);

export const client = pgTable(
  "client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceKey: text("source_key"),
    externalId: text("external_id"),
    country: text("country"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("client_tenant_idx").on(t.tenantId)],
);

export const application = pgTable(
  "application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunity.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => proposal.id, { onDelete: "set null" }),
    status: text("status").$type<ApplicationState>().notNull().default("draft"),
    submissionMode: text("submission_mode").$type<"api" | "manual" | "mock">().notNull().default("manual"),
    /** Prevents duplicate marketplace submissions. */
    idempotencyKey: text("idempotency_key").notNull(),
    externalRef: text("external_ref"),
    submittedAt: ts("submitted_at"),
    decidedAt: ts("decided_at"),
    priceUsd: usd("price_usd"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("application_idem_uq").on(t.tenantId, t.idempotencyKey),
    index("application_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Jobs & production
// ---------------------------------------------------------------------------

export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunity.id, { onDelete: "set null" }),
    applicationId: uuid("application_id").references(() => application.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => client.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    serviceFamily: text("service_family").notNull(),
    status: text("status").$type<JobState>().notNull().default("intake"),
    priceUsd: usd("price_usd").notNull(),
    /** Max authorised production spend for this job. */
    spendLimitUsd: usd("spend_limit_usd").notNull(),
    estimatedCostUsd: usd("estimated_cost_usd").notNull().default(0),
    actualCostUsd: usd("actual_cost_usd").notNull().default(0),
    repairCount: integer("repair_count").notNull().default(0),
    /** Extra automatic repairs the owner granted on top of settings.limits.maxRepairsPerJob (resumeJob, audited). */
    extraRepairs: integer("extra_repairs").notNull().default(0),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    brief: text("brief").notNull().default(""),
    dueAt: ts("due_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("job_application_uq").on(t.applicationId),
    index("job_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const workflow = pgTable(
  "workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: text("status").$type<"active" | "completed" | "failed" | "superseded">().notNull().default("active"),
    plannedBy: text("planned_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("workflow_job_idx").on(t.jobId)],
);

export const workflowStep = pgTable(
  "workflow_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    agent: text("agent").notNull(),
    capability: text("capability"),
    dependsOn: text("depends_on").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<StepState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    provider: text("provider"),
    model: text("model"),
    estimatedCostUsd: usd("estimated_cost_usd").notNull().default(0),
    actualCostUsd: usd("actual_cost_usd").notNull().default(0),
    acceptance: jsonb("acceptance").$type<string[]>().notNull().default([]),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    position: integer("position").notNull().default(0),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workflow_step_key_uq").on(t.workflowId, t.key), index("workflow_step_job_idx").on(t.jobId)],
);

export const agentRun = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    task: text("task").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    jobId: uuid("job_id"),
    stepId: uuid("step_id"),
    parentRunId: uuid("parent_run_id"),
    status: text("status").$type<RunState>().notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: usd("cost_usd").notNull().default(0),
    summary: text("summary"),
    error: text("error"),
    idempotencyKey: text("idempotency_key"),
    dependencies: text("dependencies").array().notNull().default(sql`'{}'::text[]`),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_run_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("agent_run_job_idx").on(t.jobId),
    index("agent_run_status_idx").on(t.status),
  ],
);

export const agentEvent = pgTable(
  "agent_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic cursor for live streaming. */
    seq: integer("seq").generatedAlwaysAsIdentity(),
    tenantId: uuid("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    agent: text("agent"),
    type: text("type").notNull(),
    level: text("level").$type<"debug" | "info" | "success" | "warn" | "error">().notNull().default("info"),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    jobId: uuid("job_id"),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_event_tenant_seq_idx").on(t.tenantId, t.seq),
    index("agent_event_subject_idx").on(t.subjectId),
    index("agent_event_job_idx").on(t.jobId),
  ],
);

export const asset = pgTable(
  "asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "cascade" }),
    stepId: uuid("step_id"),
    kind: text("kind").$type<"image" | "video" | "audio" | "document" | "archive" | "code" | "other">().notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    storageKey: text("storage_key").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("asset_job_idx").on(t.jobId)],
);

export const generation = pgTable(
  "generation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "cascade" }),
    stepId: uuid("step_id"),
    agentRunId: uuid("agent_run_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    estimatedCostUsd: usd("estimated_cost_usd").notNull().default(0),
    actualCostUsd: usd("actual_cost_usd"),
    costSource: text("cost_source"),
    status: text("status").$type<"pending" | "running" | "succeeded" | "failed">().notNull().default("pending"),
    latencyMs: integer("latency_ms"),
    externalTaskId: text("external_task_id"),
    assetId: uuid("asset_id"),
    qaPassed: boolean("qa_passed"),
    repairOfId: uuid("repair_of_id"),
    routeRationale: text("route_rationale"),
    error: text("error"),
    /** Per-attempt key (`<unitKey>#<n>`): a failed attempt row is never overwritten. */
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * Stable key of the deliverable unit (not attempt-scoped). A succeeded
     * generation for a unit key is reused on retry instead of paying again.
     */
    unitKey: text("unit_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("generation_idem_uq").on(t.tenantId, t.idempotencyKey),
    index("generation_unit_idx").on(t.tenantId, t.unitKey),
    index("generation_job_idx").on(t.jobId),
    index("generation_provider_idx").on(t.provider, t.model),
  ],
);

export const qaReview = pgTable(
  "qa_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    stepId: uuid("step_id"),
    generationId: uuid("generation_id"),
    reviewer: text("reviewer").notNull(),
    provider: text("provider"),
    model: text("model"),
    verdict: text("verdict").$type<"pass" | "fail">().notNull(),
    score: doublePrecision("score").notNull(),
    findings: jsonb("findings").$type<QAFinding[]>().notNull().default([]),
    summary: text("summary").notNull(),
    attempt: integer("attempt").notNull().default(1),
    /**
     * How independent the model review was: "independent" (different provider family or
     * model than the producer), "same_model" (separate review pass by the same provider+model),
     * "deterministic_only" (no model reviewed it — mock/test mode). Null on rows before 2026-09-27.
     */
    independence: text("independence").$type<"independent" | "same_model" | "deterministic_only">(),
    /** Provider/model that produced the reviewed work (null when not model-produced). */
    producerProvider: text("producer_provider"),
    producerModel: text("producer_model"),
    createdAt: createdAt(),
  },
  (t) => [index("qa_review_job_idx").on(t.jobId)],
);

export const repair = pgTable(
  "repair",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    qaReviewId: uuid("qa_review_id"),
    stepId: uuid("step_id"),
    strategy: text("strategy").$type<"repair" | "regenerate" | "reroute" | "escalate">().notNull(),
    rationale: text("rationale").notNull(),
    incrementalCostUsd: usd("incremental_cost_usd").notNull().default(0),
    status: text("status").$type<"planned" | "running" | "succeeded" | "failed" | "blocked">().notNull().default("planned"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("repair_job_idx").on(t.jobId)],
);

export const revision = pgTable(
  "revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    request: text("request").notNull(),
    interpretation: text("interpretation"),
    inScope: boolean("in_scope"),
    changeOrderUsd: usd("change_order_usd"),
    status: text("status").$type<"open" | "planned" | "done" | "declined">().notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("revision_job_idx").on(t.jobId)],
);

export interface DeliveryManifest {
  items: { assetId: string; filename: string; kind: string; bytes: number; description?: string }[];
  notes: string;
  qaSummary: string;
}

export const delivery = pgTable(
  "delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryState>().notNull().default("preparing"),
    /** Packaging attempts made for this delivery (bounded; see OPERATIONAL_DEFAULTS). */
    attempts: integer("attempts").notNull().default(0),
    /** Last packaging error (secret-free). */
    error: text("error"),
    packageAssetId: uuid("package_asset_id"),
    manifest: jsonb("manifest").$type<DeliveryManifest>(),
    clientMessage: text("client_message"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("delivery_job_idx").on(t.jobId)],
);

// ---------------------------------------------------------------------------
// Economics, metrics, audit, notifications
// ---------------------------------------------------------------------------

export const costLedgerEntry = pgTable(
  "cost_ledger_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    opportunityId: uuid("opportunity_id"),
    category: text("category")
      .$type<"inference" | "creative" | "tool" | "marketplace_fee" | "subcontractor" | "human_shadow" | "revenue">()
      .notNull(),
    kind: text("kind").$type<"estimate" | "actual">().notNull(),
    provider: text("provider"),
    model: text("model"),
    amountUsd: usd("amount_usd").notNull(),
    /** true when the provider billed real money (false for mock/local). */
    paid: boolean("paid").notNull().default(false),
    agentRunId: uuid("agent_run_id"),
    generationId: uuid("generation_id"),
    memo: text("memo").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("ledger_job_idx").on(t.jobId),
    index("ledger_opp_idx").on(t.opportunityId),
  ],
);

/**
 * Hard spend limits: a paid provider call first reserves its expected cost
 * (under a per-tenant advisory lock, counting other open reservations), then
 * settles (actual cost lands in cost_ledger_entry) or releases it.
 */
export const spendReservation = pgTable(
  "spend_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    stepId: uuid("step_id"),
    /** e.g. `reservation:<generationId|runId>`. */
    key: text("key").notNull(),
    provider: text("provider"),
    amountUsd: usd("amount_usd").notNull(),
    status: text("status").$type<"open" | "settled" | "released">().notNull().default("open"),
    actualUsd: usd("actual_usd"),
    memo: text("memo").notNull().default(""),
    createdAt: createdAt(),
    settledAt: ts("settled_at"),
  },
  (t) => [
    uniqueIndex("spend_reservation_key_uq").on(t.tenantId, t.key),
    index("spend_reservation_open_idx").on(t.tenantId, t.status, t.createdAt),
  ],
);

export const providerMetric = pgTable(
  "provider_metric",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    attempts: integer("attempts").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    qaPasses: integer("qa_passes").notNull().default(0),
    repairs: integer("repairs").notNull().default(0),
    totalCostUsd: usd("total_cost_usd").notNull().default(0),
    avgLatencyMs: integer("avg_latency_ms").notNull().default(0),
    usableRate: doublePrecision("usable_rate"),
    costPerUsableUsd: usd("cost_per_usable_usd"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_metric_uq").on(t.tenantId, t.provider, t.model, t.capability)],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<"user" | "agent" | "system">().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    fromState: text("from_state"),
    toState: text("to_state"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_tenant_created_idx").on(t.tenantId, t.createdAt), index("audit_subject_idx").on(t.subjectId)],
);

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    kind: text("kind").$type<"approval" | "alert" | "info" | "success">().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    /** De-duplicates repeated notifications. */
    dedupeKey: text("dedupe_key"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("notification_dedupe_uq").on(t.tenantId, t.dedupeKey),
  ],
);

/** Idempotency ledger for side-effecting actions (submissions, client messages, paid generations). */
export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    key: text("key").primaryKey(),
    tenantId: uuid("tenant_id"),
    scope: text("scope").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
);
