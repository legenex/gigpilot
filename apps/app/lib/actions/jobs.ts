"use server";

import { z } from "zod";
import { approveFinalDelivery, cancelJob, closeJob, confirmJobInputs, requestJobRevision, resumeJob, retryStep, setJobSpendLimit } from "@gigpilot/agents";
import { runAction } from "./run";

const PATHS = ["/", "/jobs", "/jobs/[id]", "/production"];

export async function approveDeliveryAction(jobId: string) {
  return runAction("job.approve-delivery", (ctx) => approveFinalDelivery(ctx, jobId), { revalidate: PATHS, limit: 10, message: "Final delivery approved" });
}

export async function requestRevisionAction(jobId: string, note: string) {
  return runAction("job.revision", (ctx) => requestJobRevision(ctx, jobId, note), { revalidate: PATHS, limit: 10, message: "Changes requested — Recovery Agent is reopening work" });
}

export async function closeJobAction(jobId: string) {
  return runAction("job.close", (ctx) => closeJob(ctx, jobId), { revalidate: PATHS, message: "Job closed" });
}

export async function cancelJobAction(jobId: string, reason?: string) {
  return runAction("job.cancel", (ctx) => cancelJob(ctx, jobId, reason?.slice(0, 500)), { revalidate: PATHS, limit: 5, message: "Job cancelled" });
}

export async function retryStepAction(stepId: string) {
  return runAction("step.retry", (ctx) => retryStep(ctx, stepId), { revalidate: PATHS, limit: 10, message: "Step re-queued" });
}

/** Owner confirms the brief/inputs are complete → production starts. */
export async function confirmInputsAction(jobId: string, note?: string) {
  const text = typeof note === "string" ? note.trim().slice(0, 2000) : "";
  return runAction("job.confirm-inputs", (ctx) => confirmJobInputs(ctx, jobId, text || undefined), {
    revalidate: PATHS,
    limit: 10,
    message: "Inputs confirmed — production is starting",
  });
}

const resumeSchema = z.object({
  extraAttempts: z.number().int().min(0).max(5).optional(),
  extraRepairs: z.number().int().min(0).max(5).optional(),
});

/** Owner authorises another attempt window (blocked steps) and/or extra repairs (repair limit). */
export async function resumeJobAction(jobId: string, grant: { extraAttempts?: number; extraRepairs?: number }) {
  return runAction("job.resume", (ctx) => resumeJob(ctx, jobId, resumeSchema.parse(grant)), {
    revalidate: PATHS,
    limit: 10,
    message: "Authorised — agents are resuming the job",
  });
}

const spendSchema = z.number().finite().min(0).max(100_000);

/** Owner changes the job's maximum authorised spend (still capped by the workspace/server budgets). */
export async function setJobSpendLimitAction(jobId: string, usd: number) {
  return runAction("job.spend-limit", (ctx) => setJobSpendLimit(ctx, jobId, Math.round(spendSchema.parse(usd) * 100) / 100), {
    revalidate: PATHS,
    limit: 10,
    message: "Job spend limit updated",
  });
}
