import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";

/** STUB — replaced by the real higgsfield adapter (owner: integrations agent). */
export class HiggsfieldProvider implements CreativeProvider {
  readonly key = "higgsfield";
  readonly paid = true;
  isConfigured(): boolean {
    return false;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "needs_configuration", detail: "Adapter not implemented yet", checkedAt: new Date().toISOString() };
  }
  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === "higgsfield");
  }
  async generate(_req: CreativeRequest, _option: CreativeModelOption): Promise<CreativeOutput> {
    throw new Error("higgsfield adapter not implemented");
  }
}
