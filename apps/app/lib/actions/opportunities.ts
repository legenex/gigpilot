"use server";

import {
  addManualOpportunity,
  approveOpportunity,
  approveProposal,
  reanalyseOpportunity,
  rejectOpportunity,
  rejectProposal,
  requestProposal,
  shortlistOpportunity,
  updateProposalDraft,
} from "@gigpilot/agents";
import { runAction } from "./run";

const OPP_PATHS = ["/", "/radar", "/radar/[id]", "/applications"];

export async function shortlistAction(opportunityId: string) {
  return runAction("opp.shortlist", (ctx) => shortlistOpportunity(ctx, opportunityId), { revalidate: OPP_PATHS, message: "Shortlisted" });
}

export async function approvePursuitAction(opportunityId: string) {
  return runAction("opp.approve", (ctx) => approveOpportunity(ctx, opportunityId), {
    revalidate: OPP_PATHS,
    message: "Pursuit approved — the Proposal Agent is drafting a proposal",
  });
}

export async function rejectOpportunityAction(opportunityId: string, reason?: string) {
  return runAction("opp.reject", (ctx) => rejectOpportunity(ctx, opportunityId, reason?.slice(0, 500)), { revalidate: OPP_PATHS, message: "Opportunity rejected" });
}

export async function reanalyseAction(opportunityId: string) {
  return runAction("opp.reanalyse", (ctx) => reanalyseOpportunity(ctx, opportunityId), {
    revalidate: OPP_PATHS,
    limit: 10,
    message: "Re-analysis queued — the Opportunity Analyst will re-run",
  });
}

export async function requestProposalAction(opportunityId: string) {
  return runAction("opp.request-proposal", (ctx) => requestProposal(ctx, opportunityId), { revalidate: OPP_PATHS, limit: 10, message: "New proposal draft requested" });
}

export async function updateProposalAction(
  proposalId: string,
  edits: { headline?: string; coverLetter?: string; priceUsd?: number; timelineDays?: number; assumptions?: string[] },
) {
  return runAction("proposal.edit", (ctx) => updateProposalDraft(ctx, proposalId, edits), { revalidate: OPP_PATHS, message: "Proposal draft saved" });
}

export async function approveProposalAction(proposalId: string) {
  return runAction("proposal.approve", (ctx) => approveProposal(ctx, proposalId), {
    revalidate: OPP_PATHS,
    limit: 10,
    message: "Proposal approved — commitment recorded",
  });
}

export async function rejectProposalAction(proposalId: string, reason?: string) {
  return runAction("proposal.reject", (ctx) => rejectProposal(ctx, proposalId, reason?.slice(0, 500)), { revalidate: OPP_PATHS, message: "Proposal rejected" });
}

export async function addManualOpportunityAction(input: {
  sourceKey: "upwork" | "freelancer" | "contra" | "fiverr" | "web" | "direct";
  title: string;
  description: string;
  url?: string;
  clientName?: string;
  budgetType?: "fixed" | "hourly" | "unknown";
  budgetMinUsd?: number;
  budgetMaxUsd?: number;
  deadlineAt?: string;
}) {
  return runAction("opp.manual", (ctx) => addManualOpportunity(ctx, input), {
    revalidate: ["/", "/radar"],
    limit: 20,
    message: "Opportunity added — analysis queued",
  });
}
