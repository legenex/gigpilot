import type { AgentOSAdapter, AgentOSStatusSnapshot } from "../types";
import type { ProviderHealth } from "@gigpilot/contracts";

/** STUB — AgentOS adapter boundary (owner: integrations agent). */
class NoopAgentOSAdapter implements AgentOSAdapter {
  readonly mode = "noop" as const;
  async publishStatus(_snapshot: AgentOSStatusSnapshot): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { status: "needs_configuration", detail: "AgentOS adapter not implemented yet", checkedAt: new Date().toISOString() };
  }
}

export function getAgentOSAdapter(): AgentOSAdapter {
  return new NoopAgentOSAdapter();
}
