import type { CreativeModelOption } from "@gigpilot/contracts";
import { unitsFor } from "@gigpilot/economics";

/** Catalog estimate (USD) for one generation of an option; null when the price is unknown. */
export function catalogCost(option: CreativeModelOption, durationSec?: number): number | null {
  if (option.unitCostUsd === null) return null;
  return option.unitCostUsd * unitsFor(option, durationSec);
}
