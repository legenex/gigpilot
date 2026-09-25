import type { z } from "zod";
import type { Capability } from "./analysis";

/** Integration status shown on the Integrations page. */
export const INTEGRATION_STATUSES = ["connected", "needs_configuration", "unavailable", "degraded", "error", "mock"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface ProviderHealth {
  status: IntegrationStatus;
  /** Human-readable, secret-free detail. */
  detail: string;
  latencyMs?: number;
  checkedAt: string;
  /** e.g. available model ids — never secrets. */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export type IntelligenceFamily = "factory" | "gx" | "grok" | "mock";

/**
 * Task classes drive routing. Cheap/repetitive work prefers local GX compute;
 * reasoning-heavy work prefers Factory (Router/auto); current-web research
 * prefers Grok.
 */
export type IntelligenceTask =
  | "triage"
  | "extract"
  | "classify"
  | "summarise"
  | "dedupe"
  | "tag"
  | "analyse_opportunity"
  | "market_research"
  | "web_research"
  | "proposal"
  | "plan_production"
  | "recovery"
  | "code"
  | "qa_basic"
  | "qa_high"
  | "client_message"
  | "log_analysis";

export interface IntelligenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface IntelligenceRequest<T = unknown> {
  task: IntelligenceTask;
  messages: IntelligenceMessage[];
  /** When provided the provider must return JSON validated against it. */
  schema?: z.ZodType<T>;
  /** Name used for structured output / logging. */
  schemaName?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Hard ceiling for this call. Paid providers refuse if their estimate exceeds it. */
  maxCostUsd?: number;
  /** Enable provider-native web search (Grok). */
  webSearch?: boolean;
  /** Correlation for events/ledger. */
  context?: { tenantId?: string; jobId?: string; opportunityId?: string; agentRunId?: string };
  /** Deterministic fallback used by the mock provider (test mode). */
  mockResult?: () => T | Promise<T>;
  signal?: AbortSignal;
}

export interface IntelligenceUsage {
  inputTokens: number;
  outputTokens: number;
  /** Actual cost when the provider reports it; otherwise computed from the catalog. */
  costUsd: number;
  costSource: "provider" | "catalog" | "free" | "unknown";
}

export interface IntelligenceResult<T = unknown> {
  family: IntelligenceFamily;
  model: string;
  text: string;
  data?: T;
  usage: IntelligenceUsage;
  latencyMs: number;
  /** Provider-native citations (web research). */
  citations?: { url: string; title?: string }[];
}

export interface IntelligenceProvider {
  readonly family: IntelligenceFamily;
  readonly paid: boolean;
  isConfigured(): boolean;
  health(): Promise<ProviderHealth>;
  supports(task: IntelligenceTask): boolean;
  /** Pre-flight cost estimate for budget enforcement (USD). */
  estimateCost(req: IntelligenceRequest): number;
  complete<T>(req: IntelligenceRequest<T>): Promise<IntelligenceResult<T>>;
}

// ---------------------------------------------------------------------------
// Creative
// ---------------------------------------------------------------------------

export interface CreativeModelOption {
  provider: string;
  model: string;
  capability: Capability;
  /** USD per unit (image, second of video, etc.). null = price unknown. */
  unitCostUsd: number | null;
  unit: "image" | "second" | "clip" | "minute" | "request";
  /** Prior quality estimate 0..1 before historical data. */
  qualityPrior: number;
  /** Prior usable-output rate 0..1 before historical data. */
  usableRatePrior: number;
  avgLatencySec: number;
  priceVerifiedAt?: string;
  notes?: string;
}

export interface CreativeRequest {
  capability: Capability;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: "1:1" | "4:5" | "9:16" | "16:9" | "3:2";
  durationSec?: number;
  referenceAssetUrls?: string[];
  params?: Record<string, unknown>;
  idempotencyKey: string;
  maxCostUsd: number;
  context?: { tenantId?: string; jobId?: string; stepId?: string };
}

export interface CreativeOutput {
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  /** Bytes are persisted by GigPilot storage — never rely on provider URLs. */
  files: { bytes: Uint8Array; mime: string; filename: string; width?: number; height?: number }[];
  externalTaskId?: string;
  costUsd: number;
  costSource: "provider" | "catalog" | "free" | "unknown";
  latencyMs: number;
  error?: string;
}

export interface CreativeProvider {
  readonly key: string;
  readonly paid: boolean;
  isConfigured(): boolean;
  health(): Promise<ProviderHealth>;
  models(): CreativeModelOption[];
  generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput>;
}

// ---------------------------------------------------------------------------
// Sources (marketplaces & feeds)
// ---------------------------------------------------------------------------

export type IngestionMode = "api" | "webhook" | "email" | "rss" | "manual" | "mock";

export interface SourceCapabilities {
  canSearch: boolean;
  /** True ONLY when the marketplace officially permits programmatic submission. */
  canSubmit: boolean;
  /** Every submission requires an explicit owner approval (always true for real marketplaces). */
  submitRequiresHumanConfirm: boolean;
  requiresUserOAuth: boolean;
  ingestionMode: IngestionMode;
  /** False when ToS forbid scheduled/continuous polling (e.g. Upwork: user-directed search only). */
  backgroundPollingAllowed: boolean;
  /** Minimum minutes between automated polls (ToS / rate-limit driven). */
  minPollIntervalMinutes: number;
  /** Max hours source content may be cached before it must be purged (null = no limit stated). */
  maxCacheTtlHours: number | null;
  /** Required attribution when displaying listings. */
  attribution?: { name: string; linkRequired: boolean };
  /** Short compliance note shown in the UI. */
  compliance: string;
  docsUrl?: string;
}

export interface RawOpportunity {
  sourceKey: string;
  externalId: string;
  url?: string;
  title: string;
  description: string;
  clientName?: string;
  clientCountry?: string;
  clientRating?: number;
  clientSpendUsd?: number;
  budgetType: "fixed" | "hourly" | "unknown";
  budgetMinUsd?: number;
  budgetMaxUsd?: number;
  currency?: string;
  skills?: string[];
  postedAt?: string;
  deadlineAt?: string;
  proposalsCount?: number;
  raw?: Record<string, unknown>;
}

export interface SubmissionRequest {
  externalOpportunityId: string;
  coverLetter: string;
  amountUsd: number;
  periodDays: number;
  idempotencyKey: string;
}

export interface SubmissionResult {
  status: "submitted" | "rejected" | "unsupported";
  externalRef?: string;
  detail: string;
}

export interface SourceAdapter {
  readonly key: string;
  readonly name: string;
  readonly capabilities: SourceCapabilities;
  isConfigured(): boolean;
  health(): Promise<ProviderHealth>;
  fetchOpportunities(opts: { tenantId: string; query?: string; limit?: number; since?: Date }): Promise<RawOpportunity[]>;
  submit?(req: SubmissionRequest): Promise<SubmissionResult>;
}
