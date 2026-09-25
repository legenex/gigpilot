import type { Executor } from "./client";

/**
 * Seeds realistic historical records for a demo workspace (completed jobs,
 * ledger history, provider metrics, market metrics) so the dashboard is alive
 * on first login. Fresh opportunities are NOT inserted here — they arrive via
 * the mock source through the real worker pipeline.
 *
 * Implemented in the worker/agents milestone.
 */
export async function seedDemoHistory(_db: Executor, _tenantId: string): Promise<void> {
  // placeholder — replaced by the full demo history seeder
}
