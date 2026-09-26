import { QUEUES, type QueueName, type QueuePayloads } from "@gigpilot/contracts";
import type { AgentDeps } from "./deps";
import { runOpportunityAnalyse, runOpportunityRefine } from "./agents/analyst";
import { runApplicationAward, runApplicationSubmit } from "./agents/applications";
import { runDeliveryPrepare } from "./agents/delivery";
import { runStepExecute } from "./agents/execution";
import {
  runJobMonitor,
  runMarketResearchAll,
  runMetricsRollup,
  runNotificationsDispatch,
  runOpportunityExpire,
  runProviderHealth,
  runSourceRefreshAll,
} from "./agents/maintenance";
import { runMarketResearch } from "./agents/market";
import { runWorkflowTick } from "./agents/orchestrator";
import { runJobPlan } from "./agents/planner";
import { runProposalGenerate } from "./agents/proposal";
import { runSourceRefresh } from "./agents/scout";

export type QueueHandler<Q extends QueueName> = (payload: QueuePayloads[Q], deps: AgentDeps) => Promise<unknown>;
export type QueueHandlers = { [Q in QueueName]: QueueHandler<Q> };

/** One handler per durable queue. The worker binds these to pg-boss; tests call them directly. */
export const handlers: QueueHandlers = {
  [QUEUES.sourceRefresh]: runSourceRefresh,
  [QUEUES.sourceRefreshAll]: (_p, deps) => runSourceRefreshAll(deps),
  [QUEUES.opportunityAnalyse]: runOpportunityAnalyse,
  [QUEUES.opportunityRefine]: runOpportunityRefine,
  [QUEUES.opportunityExpire]: (_p, deps) => runOpportunityExpire(deps),
  [QUEUES.proposalGenerate]: runProposalGenerate,
  [QUEUES.applicationSubmit]: runApplicationSubmit,
  [QUEUES.applicationAward]: runApplicationAward,
  [QUEUES.jobPlan]: runJobPlan,
  [QUEUES.workflowTick]: runWorkflowTick,
  [QUEUES.stepExecute]: runStepExecute,
  [QUEUES.deliveryPrepare]: runDeliveryPrepare,
  [QUEUES.marketResearch]: runMarketResearch,
  [QUEUES.marketResearchAll]: (_p, deps) => runMarketResearchAll(deps),
  [QUEUES.providerHealth]: (_p, deps) => runProviderHealth(deps),
  [QUEUES.jobMonitor]: (_p, deps) => runJobMonitor(deps),
  [QUEUES.notificationsDispatch]: (_p, deps) => runNotificationsDispatch(deps),
  [QUEUES.metricsRollup]: (_p, deps) => runMetricsRollup(deps),
};

export function handlerFor<Q extends QueueName>(name: Q): QueueHandler<Q> {
  return handlers[name] as QueueHandler<Q>;
}
