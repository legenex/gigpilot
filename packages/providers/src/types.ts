import type {
  Capability,
  CreativeModelOption,
  CreativeOutput,
  CreativeProvider,
  CreativeRequest,
  IntelligenceFamily,
  IntelligenceProvider,
  IntelligenceRequest,
  IntelligenceResult,
  ProviderHealth,
  SourceAdapter,
} from "@gigpilot/contracts";

/**
 * Public API of @gigpilot/providers. Agents and the dashboard depend ONLY on
 * these shapes — never on a vendor module directly.
 */

/** Spend authority for a single call, computed by the agent runtime from env + tenant settings + today's ledger. */
export interface BudgetContext {
  /** Paid providers may be used at all (env budget > 0 AND tenant daily limit > 0). */
  allowPaid: boolean;
  /** Remaining paid USD today for this tenant (and within the job's spend limit when applicable). */
  remainingPaidUsd: number;
}

export interface ProviderCallContext {
  tenantId: string | null;
  budget: BudgetContext;
  /** Families permitted by tenant settings.routing.allowedModelFamilies (mock always allowed). */
  allowedFamilies?: string[];
  preferLocalForCheapTasks?: boolean;
}

export interface FallbackRecord {
  family: IntelligenceFamily;
  reason: string;
}

export interface RoutedIntelligenceResult<T> extends IntelligenceResult<T> {
  /** Providers skipped or failed before the one that answered (for provider.fallback events). */
  fallbacks: FallbackRecord[];
  /** true when the answering provider bills real money. */
  paid: boolean;
}

export interface IntelligenceRouter {
  complete<T>(req: IntelligenceRequest<T>, ctx: ProviderCallContext): Promise<RoutedIntelligenceResult<T>>;
  /** Ordered provider preference for a task (for display / diagnostics). */
  routeFor(task: IntelligenceRequest["task"], ctx: ProviderCallContext): IntelligenceFamily[];
  providers(): IntelligenceProvider[];
}

export interface CreativeRouteDecision {
  option: CreativeModelOption;
  rationale: string;
  expectedCostPerUsableUsd: number | null;
  predictedQuality: number;
  /** "mock" when real providers are unavailable or unaffordable. */
  mode: "live" | "mock";
}

export interface CreativeGenerateOptions extends ProviderCallContext {
  qualityThreshold: number;
  preference: string[];
  /** Observed provider metrics for routing (usable rates). */
  metrics?: { provider: string; model: string; capability: string; usableRate: number | null; attempts: number }[];
  /** Exclude provider/model combos (used by Recovery to reroute). */
  exclude?: { provider: string; model: string }[];
  /** Mock-only: deterministic defect to inject (demo QA failure). */
  simulateDefect?: string | null;
}

export interface CreativeBroker {
  plan(capability: Capability, opts: CreativeGenerateOptions): CreativeRouteDecision;
  generate(req: CreativeRequest, opts: CreativeGenerateOptions): Promise<CreativeOutput & { decision: CreativeRouteDecision }>;
  providers(): CreativeProvider[];
}

export interface StoredObject {
  key: string;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface StorageAdapter {
  readonly driver: "filesystem" | "s3";
  put(key: string, data: Uint8Array, mime: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface AgentOSStatusSnapshot {
  service: "gigpilot";
  version: string;
  generatedAt: string;
  health: "ok" | "degraded" | "down";
  queues: Record<string, { queued: number; active: number; failed: number }>;
  pending: { approvals: number; activeJobs: number; awaitingFinalApproval: number; failedStepsLast24h: number };
  lastErrors: { at: string; message: string }[];
}

export interface AgentOSAdapter {
  readonly mode: "noop" | "file" | "http";
  publishStatus(snapshot: AgentOSStatusSnapshot): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export type { CreativeOutput, CreativeRequest, IntelligenceRequest, ProviderHealth, SourceAdapter };
