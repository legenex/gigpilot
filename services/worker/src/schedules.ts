import { QUEUES, type QueueName } from "@gigpilot/contracts";

/** Recurring maintenance (UTC cron). Fan-out jobs respect each source's capabilities and poll intervals. */
export const SCHEDULES: { queue: QueueName; cron: string; description: string }[] = [
  { queue: QUEUES.sourceRefreshAll, cron: "*/30 * * * *", description: "Refresh every enabled source that permits background polling" },
  { queue: QUEUES.opportunityExpire, cron: "7 * * * *", description: "Expire stale opportunities and purge time-limited source content" },
  { queue: QUEUES.marketResearchAll, cron: "15 */6 * * *", description: "Market research per workspace" },
  { queue: QUEUES.providerHealth, cron: "*/15 * * * *", description: "Zero-cost provider and source health checks" },
  { queue: QUEUES.jobMonitor, cron: "*/10 * * * *", description: "Deadline risk, stuck steps, lost ticks" },
  { queue: QUEUES.metricsRollup, cron: "25 * * * *", description: "Provider metrics for routing" },
  { queue: QUEUES.notificationsDispatch, cron: "*/5 * * * *", description: "Internal notification digest (no external sends)" },
];

export const SCHEDULED_QUEUES = new Set<QueueName>(SCHEDULES.map((s) => s.queue));

/** Per-queue worker concurrency (GX gx-code has 2 slots → analysis capped at 2). */
export const CONCURRENCY: Record<QueueName, number> = {
  [QUEUES.sourceRefresh]: 2,
  [QUEUES.sourceRefreshAll]: 1,
  [QUEUES.opportunityAnalyse]: 2,
  [QUEUES.opportunityExpire]: 1,
  [QUEUES.proposalGenerate]: 2,
  [QUEUES.applicationSubmit]: 1,
  [QUEUES.applicationAward]: 1,
  [QUEUES.jobPlan]: 1,
  [QUEUES.workflowTick]: 2,
  [QUEUES.stepExecute]: 3,
  [QUEUES.deliveryPrepare]: 1,
  [QUEUES.marketResearch]: 1,
  [QUEUES.marketResearchAll]: 1,
  [QUEUES.providerHealth]: 1,
  [QUEUES.jobMonitor]: 1,
  [QUEUES.notificationsDispatch]: 1,
  [QUEUES.metricsRollup]: 1,
};

/** Poll interval (s): the live pipeline polls fast; housekeeping polls slowly. */
export function pollingIntervalFor(queue: QueueName): number {
  return SCHEDULED_QUEUES.has(queue) || queue === QUEUES.marketResearch ? 10 : 2;
}
