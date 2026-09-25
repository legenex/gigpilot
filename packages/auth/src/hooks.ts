import { QUEUES } from "@gigpilot/contracts";
import { emitEvent, getDb } from "@gigpilot/db";
import { enqueue } from "@gigpilot/db/queue";
import { seedDemoHistory } from "@gigpilot/db/demo";

/**
 * Runs once when a workspace is created. Demo workspaces get realistic
 * history plus a live mock sourcing run that flows through the real
 * pipeline (scout → analyst → economics → proposal) in the worker.
 */
export async function onWorkspaceCreated(input: { tenantId: string; userId: string; demo: boolean }): Promise<void> {
  const db = getDb();
  if (input.demo) {
    await seedDemoHistory(db, input.tenantId);
  }
  await emitEvent(db, {
    tenantId: input.tenantId,
    type: "system",
    agent: "orchestrator",
    level: "info",
    message: input.demo
      ? "Workspace created in demo mode — sourcing from the demo marketplace through the live pipeline."
      : "Workspace created — connect a source in Integrations to start sourcing.",
  });
  try {
    await enqueue(QUEUES.sourceRefresh, { tenantId: input.tenantId, sourceKey: "mock" }, { singletonKey: `${input.tenantId}:mock` });
    await enqueue(QUEUES.marketResearch, { tenantId: input.tenantId }, { singletonKey: input.tenantId, startAfter: 20 });
    await enqueue(QUEUES.providerHealth, {}, {});
  } catch (err) {
    // Queue unavailable must never block sign-up; the scheduler will pick the tenant up.
    console.error(JSON.stringify({ level: "warn", msg: "workspace kickoff enqueue failed", error: String(err) }));
  }
}
