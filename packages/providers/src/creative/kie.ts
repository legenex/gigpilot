import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";

/** STUB — replaced by the real kie adapter (owner: integrations agent). */
export class KieProvider implements CreativeProvider {
  readonly key = "kie";
  readonly paid = true;
  isConfigured(): boolean {
    return false;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "needs_configuration", detail: "Adapter not implemented yet", checkedAt: new Date().toISOString() };
  }
  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === "kie");
  }
  async generate(_req: CreativeRequest, _option: CreativeModelOption): Promise<CreativeOutput> {
    throw new Error("kie adapter not implemented");
  }
}
