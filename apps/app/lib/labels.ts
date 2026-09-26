import { AGENTS, INTEGRATIONS, type ApplicationState, type JobState, type OpportunityState, type ProposalState, type RunState, type StepState } from "@gigpilot/contracts";
import type { Tone } from "@gigpilot/ui";

export interface StateMeta {
  label: string;
  tone: Tone;
  /** Work is actively happening in this state (status dot pulses). */
  live?: boolean;
}

export const OPPORTUNITY_META: Record<OpportunityState, StateMeta> = {
  new: { label: "New", tone: "neutral" },
  analysing: { label: "Analysing", tone: "info", live: true },
  analysed: { label: "Analysed", tone: "neutral" },
  shortlisted: { label: "Shortlisted", tone: "violet" },
  rejected: { label: "Rejected", tone: "neutral" },
  pursuing: { label: "Pursuing", tone: "info" },
  applied: { label: "Applied", tone: "info" },
  won: { label: "Won", tone: "profit" },
  lost: { label: "Lost", tone: "risk" },
  expired: { label: "Expired", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export const PROPOSAL_META: Record<ProposalState, StateMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "accent" },
  approved: { label: "Approved", tone: "profit" },
  rejected: { label: "Rejected", tone: "risk" },
  superseded: { label: "Superseded", tone: "neutral" },
};

export const APPLICATION_META: Record<ApplicationState, StateMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  submitted: { label: "Submitted", tone: "info" },
  client_response: { label: "Client response", tone: "violet" },
  negotiating: { label: "Negotiating", tone: "violet" },
  won: { label: "Won", tone: "profit" },
  lost: { label: "Lost", tone: "risk" },
  expired: { label: "Expired", tone: "neutral" },
};

export const JOB_META: Record<JobState, StateMeta> = {
  intake: { label: "Intake", tone: "neutral", live: true },
  planning: { label: "Planning", tone: "info", live: true },
  awaiting_inputs: { label: "Awaiting inputs", tone: "warn" },
  ready: { label: "Ready", tone: "info" },
  executing: { label: "Executing", tone: "info", live: true },
  qa: { label: "QA", tone: "violet", live: true },
  repairing: { label: "Repairing", tone: "warn", live: true },
  awaiting_final_approval: { label: "Awaiting final approval", tone: "accent" },
  delivered: { label: "Delivered", tone: "profit" },
  closed: { label: "Closed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "risk" },
};

export const STEP_META: Record<StepState, StateMeta> = {
  pending: { label: "Pending", tone: "neutral" },
  ready: { label: "Ready", tone: "neutral" },
  running: { label: "Running", tone: "info", live: true },
  succeeded: { label: "Succeeded", tone: "profit" },
  failed: { label: "Failed", tone: "risk" },
  blocked: { label: "Blocked", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const RUN_META: Record<RunState, StateMeta> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info", live: true },
  succeeded: { label: "Succeeded", tone: "profit" },
  failed: { label: "Failed", tone: "risk" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const DELIVERY_META: Record<string, StateMeta> = {
  preparing: { label: "Preparing", tone: "info", live: true },
  prepared: { label: "Ready for review", tone: "accent" },
  approved: { label: "Approved", tone: "profit" },
  sent: { label: "Sent", tone: "profit" },
  rejected: { label: "Changes requested", tone: "warn" },
};

export const RECOMMENDATION_META: Record<"pursue" | "consider" | "skip", StateMeta> = {
  pursue: { label: "Pursue", tone: "profit" },
  consider: { label: "Consider", tone: "warn" },
  skip: { label: "Skip", tone: "neutral" },
};

export const INTEGRATION_STATUS_META: Record<string, StateMeta> = {
  connected: { label: "Connected", tone: "profit" },
  needs_configuration: { label: "Needs configuration", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "neutral" },
  degraded: { label: "Degraded", tone: "warn" },
  error: { label: "Error", tone: "risk" },
  mock: { label: "Mock", tone: "info" },
};

export function sourceName(key: string): string {
  return INTEGRATIONS.find((i) => i.key === key)?.name ?? key;
}

/** Short source label for dense tables. */
export const SOURCE_SHORT: Record<string, string> = {
  upwork: "Upwork",
  freelancer: "Freelancer",
  contra: "Contra",
  fiverr: "Fiverr",
  web: "Web feed",
  direct: "Direct",
  mock: "Demo",
};

export function agentName(key: string | null | undefined): string {
  if (!key) return "System";
  return (AGENTS as Record<string, { name: string }>)[key]?.name ?? key;
}

export const COST_CATEGORY_META: Record<string, { label: string; color: string }> = {
  inference: { label: "Inference", color: "var(--gp-series-1)" },
  creative: { label: "Creative", color: "var(--gp-series-2)" },
  tool: { label: "Tools", color: "var(--gp-series-3)" },
  subcontractor: { label: "Subcontractor", color: "var(--gp-series-3)" },
  marketplace_fee: { label: "Marketplace fees", color: "var(--gp-series-4)" },
  human_shadow: { label: "Human shadow", color: "var(--gp-fg-3)" },
  revenue: { label: "Revenue", color: "var(--gp-profit)" },
};

export const LEVEL_TONE: Record<string, Tone> = {
  debug: "neutral",
  info: "neutral",
  success: "profit",
  warn: "warn",
  error: "risk",
};

export function humanize(s: string): string {
  return s.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
