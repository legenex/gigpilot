/**
 * Canonical business defaults. These seed each tenant's settings row and are
 * the ONLY place default thresholds live. Runtime code must read thresholds
 * from tenant settings (see @gigpilot/contracts `TenantSettings`), never from
 * literals.
 */
export const BUSINESS_DEFAULTS = {
  thresholds: {
    /** Minimum target gross margin (0..1). */
    minGrossMargin: 0.5,
    /** Minimum expected gross profit in USD. */
    minExpectedProfitUsd: 300,
    /** Preferred minimum opportunity budget in USD (soft gate). */
    preferredMinBudgetUsd: 300,
    /** Below this capability fit a profitable brief is downgraded to "consider". */
    minFitScore: 0.55,
    /** Below this analysis confidence a profitable brief is downgraded to "consider". */
    minConfidence: 0.5,
  },
  economics: {
    /** Human-time shadow cost per hour (USD) for owner review/coordination time. */
    shadowHourlyRateUsd: 60,
    /** General contingency as a fraction of fulfilment cost. */
    contingencyPct: 0.15,
    /** Expected number of revision rounds for a typical job. */
    expectedRevisionRounds: 1,
    /** Cost of one revision round as a fraction of first-pass production cost. */
    revisionCostFraction: 0.35,
    /** Default hourly price used to value hourly opportunities when no rate is proposed. */
    defaultHourlyRateUsd: 85,
  },
  goals: {
    viableOpportunitiesPerDay: { min: 20, max: 40 },
    pursueWorthyPerDay: { min: 3, max: 5 },
    paidJobsFirst30Days: { min: 2, max: 3 },
    costEstimateAccuracyPct: 20,
    ownerTouchpointsPerJob: 3,
  },
  autonomy: {
    /** Owner must approve which opportunities are pursued. */
    requireOpportunityApproval: true,
    /** Owner must approve proposal/price/scope before any commercial commitment. */
    requireProposalApproval: true,
    /** Submit automatically after approval where the marketplace officially permits it. */
    autoSubmitWhenPermitted: true,
    /** Owner must approve final client delivery. */
    requireFinalDeliveryApproval: true,
    /** Allow routine production repairs inside spend/attempt limits without asking. */
    autoRepairWithinLimits: true,
    /** Allow GigPilot to send client messages automatically (never by default). */
    autoSendClientMessages: false,
  },
  limits: {
    /** Max authorised production spend per job (USD). */
    perJobSpendLimitUsd: 150,
    /** Max paid-provider spend per tenant per day (USD). 0 = paid providers disabled (mock/test mode). */
    dailyPaidSpendLimitUsd: 0,
    /** Max attempts per workflow step (first attempt included). */
    maxStepAttempts: 3,
    /** Max repair cycles per job. */
    maxRepairsPerJob: 4,
    /** Max generations per workflow step. */
    maxGenerationsPerStep: 6,
    /**
     * Max heavy local-model (GX gx-code) calls per tenant per UTC day. The GX
     * cluster is shared; beyond this a workspace falls back to triage/mock so a
     * sign-up flood cannot starve other workspaces (and other GX clients).
     */
    dailyLocalModelCalls: 150,
    /** Max background GX refinements of pursue candidates per tenant per hour (highest expected profit first). */
    maxRefinesPerHour: 6,
  },
  routing: {
    /** Preferred creative provider order before cost/quality scoring. */
    creativeProviderPreference: ["kie", "higgsfield"] as string[],
    /** Minimum predicted quality (0..1) a creative route must clear. */
    creativeQualityThreshold: 0.72,
    /** Model families the router may use. */
    allowedModelFamilies: ["factory", "gx", "grok"] as string[],
    /** Prefer local GX compute for triage/extraction when healthy. */
    preferLocalForCheapTasks: true,
  },
  sourcing: {
    refreshIntervalMinutes: 30,
    opportunityMaxAgeHours: 96,
    /** Submitted / client_response applications idle this long are marked expired (audited). */
    applicationExpiryDays: 21,
  },
  demo: {
    /** Demo workspaces inject one labelled simulated defect so the QA → repair loop is visible. */
    injectDefect: true,
  },
} as const;

/**
 * Operational (non-business) constants: engine timing, retry bounds and
 * safety margins. They are named here — never inlined — and documented in
 * .ai/DECISIONS.md (D12). Business thresholds stay in BUSINESS_DEFAULTS.
 */
export const OPERATIONAL_DEFAULTS = {
  /** Max steps of one job executing concurrently. */
  jobParallelism: 2,
  /** A job's initial spend limit = min(perJobSpendLimitUsd, max(buffered estimate × this, minJobSpendLimitUsd)). */
  jobSpendBufferMultiplier: 2.5,
  /** Floor for a job's initial spend limit (USD) so tiny estimates still leave room for one repair. */
  minJobSpendLimitUsd: 10,
  /** Owner ceiling for setJobSpendLimit when PAID_PROVIDER_DAILY_BUDGET_USD is 0: perJobSpendLimitUsd × this. */
  spendLimitCeilingMultiplier: 10,
  /** A running step is declared stuck this long AFTER its queue expiry (the handler is aborted at expiry). */
  stuckStepGraceMinutes: 15,
  /** Agent runs still `running` after this are marked abandoned. */
  staleRunMinutes: 120,
  /** A delivery still `preparing` after this is re-queued by the job monitor. */
  stalePreparingDeliveryMinutes: 15,
  /** Packaging attempts per delivery row inside one delivery-prepare job before it is marked failed. */
  deliveryPackagingAttempts: 3,
  /** Job-monitor re-queues of a failed/stale delivery before the owner is alerted instead. */
  deliveryMonitorRequeues: 5,
  /** Outbox sweeper: an item idle this long without its follow-up work is re-enqueued. */
  outboxIdleMinutes: 5,
  /** Outbox sweeper: re-enqueues per item before the owner is alerted instead. */
  outboxMaxRequeues: 5,
  /** Owner reminder when a job waits for client inputs longer than this (deduped per day). */
  awaitingInputsReminderHours: 24,
  /** `running` generations older than this are orphans (worker died) and are marked failed. */
  orphanGenerationMinutes: 60,
  /** Open spend reservations older than this are released (worker died mid-call). */
  spendReservationTtlMinutes: 120,
  /** Router circuit breaker: consecutive availability failures before a family is skipped. */
  circuitBreakerFailures: 3,
  /** Router circuit breaker: how long an open circuit skips the family before a half-open probe. */
  circuitBreakerCooldownSeconds: 60,
  /** Automatic step retries back off: startAfter = base × 2^(failed attempts − 1) … */
  stepRetryBaseSeconds: 30,
  /** … capped at this many seconds. */
  stepRetryMaxSeconds: 600,
  /** AgentOS health is `connected` only when the status snapshot was written within this window. */
  agentosStatusFreshMinutes: 5,
  /** Public web-feed reachability checks (health) are cached at least this long. */
  webFeedHealthCacheMinutes: 60,
} as const;

/** Initial service families GigPilot understands. Configurable per tenant (Market Lab). */
export const SERVICE_FAMILIES = [
  {
    key: "paid-social-ugc",
    name: "Paid social creatives & UGC",
    description: "Scroll-stopping ad creatives, UGC-style videos, hooks and variants for Meta/TikTok.",
    defaultAllocationPct: 20,
  },
  {
    key: "image-design",
    name: "Image & design",
    description: "Product imagery, brand visuals, social graphics, thumbnails and design systems.",
    defaultAllocationPct: 15,
  },
  {
    key: "localization-repurposing",
    name: "Localization & repurposing",
    description: "Translate, dub, subtitle and re-cut existing content for new markets and formats.",
    defaultAllocationPct: 10,
  },
  {
    key: "ai-automation",
    name: "AI automation & agents",
    description: "Workflow automation, AI agents, integrations and internal tools.",
    defaultAllocationPct: 25,
  },
  {
    key: "web-app-builds",
    name: "Web & application builds",
    description: "Marketing sites, landing pages, web apps and MVPs.",
    defaultAllocationPct: 20,
  },
  {
    key: "research-content",
    name: "Research & content systems",
    description: "Market research, content engines, SEO programs and knowledge bases.",
    defaultAllocationPct: 10,
  },
] as const;

export type ServiceFamilyKey = (typeof SERVICE_FAMILIES)[number]["key"];

/**
 * Marketplace fee schedules charged to the freelancer. Values are defaults and
 * are editable in Settings; `verifiedAt` records when they were last checked.
 */
export const PLATFORM_FEE_DEFAULTS: Record<
  string,
  { pct: number; fixedUsd: number; minUsd: number; note: string }
> = {
  upwork: { pct: 0.1, fixedUsd: 0, minUsd: 0, note: "Upwork variable freelancer service fee; 10% default assumption." },
  freelancer: { pct: 0.1, fixedUsd: 0, minUsd: 5, note: "Freelancer.com fixed-price project fee 10% or $5 minimum." },
  fiverr: { pct: 0.2, fixedUsd: 0, minUsd: 0, note: "Fiverr seller commission 20%." },
  contra: { pct: 0, fixedUsd: 0, minUsd: 0, note: "Contra is commission-free for independents." },
  direct: { pct: 0.03, fixedUsd: 0.3, minUsd: 0, note: "Direct client — card processing estimate." },
  web: { pct: 0.03, fixedUsd: 0.3, minUsd: 0, note: "Public web opportunity — card processing estimate." },
  mock: { pct: 0.1, fixedUsd: 0, minUsd: 0, note: "Demo marketplace." },
};

export const PORTS = {
  web: 4710,
  app: 4711,
  worker: 4712,
  postgres: 4715,
} as const;
