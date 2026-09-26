/** Agent names used across runs, events and the Agents page. */
export const AGENTS = {
  orchestrator: { name: "Orchestrator", role: "Owns end-to-end execution, scheduling, delegation and cost enforcement." },
  market_research: { name: "Market Research", role: "Researches demand, pricing, competition and fulfilment economics." },
  scout: { name: "Opportunity Scout", role: "Collects and normalises opportunities from permitted sources." },
  analyst: { name: "Opportunity Analyst", role: "Extracts deliverables, assets, risks and a probable workflow." },
  economics: { name: "Economics", role: "Deterministic cost, fee, contingency, profit and margin calculation." },
  proposal: { name: "Proposal", role: "Writes tailored, specific proposals for owner approval." },
  planner: { name: "Production Planner", role: "Turns an accepted job into an executable workflow DAG." },
  creative: { name: "Creative Production", role: "Generates images, video and design assets via the creative broker." },
  coder: { name: "Coding", role: "Builds software deliverables via Factory / GX coding workers." },
  automation: { name: "Automation", role: "Builds integrations and agent workflows." },
  researcher: { name: "Research", role: "Produces research and content-system deliverables." },
  copywriter: { name: "Copy & Content", role: "Writes hooks, scripts, captions and long-form copy." },
  localiser: { name: "Localisation", role: "Translates, subtitles and adapts content." },
  finisher: { name: "Media Finishing", role: "Assembles, formats and packages final media." },
  qa: { name: "QA Evaluator", role: "Independently checks work against the brief and acceptance criteria." },
  recovery: { name: "Recovery", role: "Diagnoses failures and repairs, regenerates or reroutes within limits." },
  client: { name: "Client", role: "Drafts questions, updates, change orders and delivery notes." },
} as const;

export type AgentKey = keyof typeof AGENTS;

export const EVENT_LEVELS = ["debug", "info", "success", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** Canonical event types written to agent_event (the live activity stream). */
export type EventType =
  | "source.refreshed"
  | "source.failed"
  | "opportunity.discovered"
  | "opportunity.duplicate"
  | "opportunity.analysed"
  | "opportunity.scored"
  | "opportunity.shortlisted"
  | "opportunity.rejected"
  | "opportunity.expired"
  | "proposal.generated"
  | "proposal.approved"
  | "proposal.rejected"
  | "application.submitted"
  | "application.manual_submission_required"
  | "application.won"
  | "application.lost"
  | "job.created"
  | "job.state"
  | "workflow.planned"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "generation.completed"
  | "generation.failed"
  | "qa.passed"
  | "qa.failed"
  | "repair.started"
  | "repair.completed"
  | "repair.limit_reached"
  | "delivery.prepared"
  | "delivery.approved"
  | "cost.recorded"
  | "budget.blocked"
  | "budget.reserved"
  | "step.interrupted"
  | "step.stale_result"
  | "step.blocked"
  | "job.resumed"
  | "delivery.failed"
  | "provider.quota"
  | "security.output_rejected"
  | "outbox.requeued"
  | "provider.health"
  | "provider.fallback"
  | "market.insight"
  | "agent.run"
  | "system";

export type SubjectType =
  | "tenant"
  | "opportunity"
  | "proposal"
  | "application"
  | "job"
  | "workflow"
  | "step"
  | "generation"
  | "delivery"
  | "market"
  | "provider"
  | "source";

export const QUEUES = {
  sourceRefresh: "source-refresh",
  sourceRefreshAll: "source-refresh-all",
  opportunityAnalyse: "opportunity-analyse",
  opportunityRefine: "opportunity-refine",
  opportunityExpire: "opportunity-expire",
  proposalGenerate: "proposal-generate",
  applicationSubmit: "application-submit",
  applicationAward: "application-award",
  jobPlan: "job-plan",
  workflowTick: "workflow-tick",
  stepExecute: "step-execute",
  deliveryPrepare: "delivery-prepare",
  marketResearch: "market-research",
  marketResearchAll: "market-research-all",
  providerHealth: "provider-health",
  jobMonitor: "job-monitor",
  notificationsDispatch: "notifications-dispatch",
  metricsRollup: "metrics-rollup",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface QueuePayloads {
  "source-refresh": { tenantId: string; sourceKey: string };
  "source-refresh-all": Record<string, never>;
  /** force = owner-requested deep (model) analysis instead of triage. */
  "opportunity-analyse": { tenantId: string; opportunityId: string; force?: boolean; refine?: boolean };
  /** GX refinement of a triaged pursue candidate (own queue: single heavy-model slot). */
  "opportunity-refine": { tenantId: string; opportunityId: string };
  "opportunity-expire": Record<string, never>;
  "proposal-generate": { tenantId: string; opportunityId: string; requestedBy?: string };
  "application-submit": { tenantId: string; applicationId: string };
  "application-award": { tenantId: string; applicationId: string };
  "job-plan": { tenantId: string; jobId: string };
  "workflow-tick": { tenantId: string; jobId: string };
  "step-execute": { tenantId: string; jobId: string; stepId: string; attempt: number };
  "delivery-prepare": { tenantId: string; jobId: string };
  "market-research": { tenantId: string };
  "market-research-all": Record<string, never>;
  "provider-health": Record<string, never>;
  "job-monitor": Record<string, never>;
  "notifications-dispatch": Record<string, never>;
  "metrics-rollup": Record<string, never>;
}
