"use server";

import { approveFinalDelivery, cancelJob, closeJob, requestJobRevision, retryStep } from "@gigpilot/agents";
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
