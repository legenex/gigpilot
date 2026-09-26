import "server-only";
import { APPLICATION_STATES, type ApplicationState } from "@gigpilot/contracts";
import { and, application, desc, eq, getDb, job, opportunity, proposal } from "@gigpilot/db";
import { getSourceAdapter } from "@gigpilot/providers";

export interface ApplicationRow {
  id: string;
  status: ApplicationState;
  submissionMode: "api" | "manual" | "mock";
  externalRef: string | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  updatedAt: Date;
  priceUsd: number | null;
  opportunityId: string;
  title: string;
  sourceKey: string;
  url: string | null;
  clientName: string | null;
  expectedProfitUsd: number | null;
  proposalId: string | null;
  timelineDays: number | null;
  jobId: string | null;
  canSubmitViaApi: boolean;
}

export interface PendingProposal {
  id: string;
  opportunityId: string;
  title: string;
  sourceKey: string;
  priceUsd: number;
  timelineDays: number;
  updatedAt: Date;
}

export async function getApplications(tenantId: string) {
  const db = getDb();
  const [rows, pendingProposals] = await Promise.all([
    db
      .select({
        id: application.id,
        status: application.status,
        submissionMode: application.submissionMode,
        externalRef: application.externalRef,
        submittedAt: application.submittedAt,
        decidedAt: application.decidedAt,
        updatedAt: application.updatedAt,
        priceUsd: application.priceUsd,
        opportunityId: application.opportunityId,
        title: opportunity.title,
        sourceKey: opportunity.sourceKey,
        url: opportunity.url,
        clientName: opportunity.clientName,
        expectedProfitUsd: opportunity.expectedProfitUsd,
        proposalId: application.proposalId,
        timelineDays: proposal.timelineDays,
        jobId: job.id,
      })
      .from(application)
      .innerJoin(opportunity, eq(opportunity.id, application.opportunityId))
      .leftJoin(proposal, eq(proposal.id, application.proposalId))
      .leftJoin(job, eq(job.applicationId, application.id))
      .where(eq(application.tenantId, tenantId))
      .orderBy(desc(application.updatedAt))
      .limit(300),
    // Proposals awaiting approval have no application row yet — they are the "Awaiting approval" column.
    db
      .select({
        id: proposal.id,
        opportunityId: proposal.opportunityId,
        title: opportunity.title,
        sourceKey: opportunity.sourceKey,
        priceUsd: proposal.priceUsd,
        timelineDays: proposal.timelineDays,
        updatedAt: proposal.updatedAt,
      })
      .from(proposal)
      .innerJoin(opportunity, eq(opportunity.id, proposal.opportunityId))
      .where(and(eq(proposal.tenantId, tenantId), eq(proposal.status, "awaiting_approval")))
      .orderBy(desc(proposal.updatedAt)),
  ]);

  const apps: ApplicationRow[] = rows.map((r) => ({ ...r, canSubmitViaApi: Boolean(getSourceAdapter(r.sourceKey)?.capabilities.canSubmit) }));
  const counts = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0])) as Record<ApplicationState, number>;
  for (const a of apps) counts[a.status] += 1;
  counts.awaiting_approval += pendingProposals.length;
  return { apps, pendingProposals: pendingProposals as PendingProposal[], counts };
}
