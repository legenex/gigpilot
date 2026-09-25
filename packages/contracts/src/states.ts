/**
 * Explicit runtime state machines. Every status change in GigPilot goes
 * through `assertTransition` (see @gigpilot/db `transition*` helpers), which
 * also writes an audit event. States may never be skipped silently.
 */

export const OPPORTUNITY_STATES = [
  "new",
  "analysing",
  "analysed",
  "shortlisted",
  "rejected",
  "pursuing",
  "applied",
  "won",
  "lost",
  "expired",
  "archived",
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const OPPORTUNITY_TRANSITIONS: Record<OpportunityState, readonly OpportunityState[]> = {
  new: ["analysing", "expired", "archived", "rejected"],
  analysing: ["analysed", "new", "expired"],
  analysed: ["shortlisted", "rejected", "analysing", "expired", "pursuing"],
  shortlisted: ["pursuing", "rejected", "analysing", "expired"],
  rejected: ["shortlisted", "archived", "analysing"],
  pursuing: ["applied", "shortlisted", "rejected", "expired"],
  applied: ["won", "lost", "expired"],
  won: ["archived"],
  lost: ["archived"],
  expired: ["archived"],
  archived: [],
};

export const PROPOSAL_STATES = ["draft", "awaiting_approval", "approved", "rejected", "superseded"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const PROPOSAL_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  draft: ["awaiting_approval", "superseded"],
  awaiting_approval: ["approved", "rejected", "superseded", "draft"],
  approved: ["superseded"],
  rejected: ["draft", "superseded"],
  superseded: [],
};

export const APPLICATION_STATES = [
  "draft",
  "awaiting_approval",
  "approved",
  "submitted",
  "client_response",
  "negotiating",
  "won",
  "lost",
  "expired",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const APPLICATION_TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  draft: ["awaiting_approval", "expired"],
  awaiting_approval: ["approved", "draft", "expired", "lost"],
  approved: ["submitted", "awaiting_approval", "expired"],
  submitted: ["client_response", "won", "lost", "expired"],
  client_response: ["negotiating", "won", "lost"],
  negotiating: ["won", "lost", "client_response"],
  won: [],
  lost: [],
  expired: [],
};

export const JOB_STATES = [
  "intake",
  "planning",
  "awaiting_inputs",
  "ready",
  "executing",
  "qa",
  "repairing",
  "awaiting_final_approval",
  "delivered",
  "closed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  intake: ["planning", "cancelled"],
  planning: ["awaiting_inputs", "ready", "cancelled"],
  awaiting_inputs: ["ready", "planning", "cancelled"],
  ready: ["executing", "cancelled"],
  executing: ["qa", "repairing", "awaiting_inputs", "cancelled"],
  qa: ["repairing", "awaiting_final_approval", "executing", "cancelled"],
  repairing: ["qa", "executing", "cancelled"],
  awaiting_final_approval: ["delivered", "repairing", "cancelled"],
  delivered: ["closed", "repairing"],
  closed: [],
  cancelled: [],
};

export const STEP_STATES = ["pending", "ready", "running", "succeeded", "failed", "blocked", "skipped", "cancelled"] as const;
export type StepState = (typeof STEP_STATES)[number];
export const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  pending: ["ready", "skipped", "cancelled", "blocked"],
  ready: ["running", "cancelled", "blocked"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: ["ready"], // re-opened by a repair (new attempt row is recorded)
  failed: ["ready", "blocked", "cancelled"],
  blocked: ["ready", "cancelled"],
  skipped: [],
  cancelled: [],
};

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const DELIVERY_STATES = ["preparing", "prepared", "approved", "sent", "rejected"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const DELIVERY_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  preparing: ["prepared"],
  prepared: ["approved", "rejected"],
  approved: ["sent"],
  sent: [],
  rejected: ["preparing"],
};

export type Machine = "opportunity" | "proposal" | "application" | "job" | "step" | "run" | "delivery";

const MACHINES: Record<Machine, Record<string, readonly string[]>> = {
  opportunity: OPPORTUNITY_TRANSITIONS,
  proposal: PROPOSAL_TRANSITIONS,
  application: APPLICATION_TRANSITIONS,
  job: JOB_TRANSITIONS,
  step: STEP_TRANSITIONS,
  run: RUN_TRANSITIONS,
  delivery: DELIVERY_TRANSITIONS,
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly machine: Machine,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${machine} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(machine: Machine, from: string, to: string): boolean {
  return MACHINES[machine][from]?.includes(to) ?? false;
}

export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new InvalidTransitionError(machine, from, to);
}

export function isTerminal(machine: Machine, state: string): boolean {
  return (MACHINES[machine][state]?.length ?? 0) === 0;
}
