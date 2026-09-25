import type { SourceAdapter } from "@gigpilot/contracts";
import { ContraSource } from "./contra";
import { DirectSource } from "./direct";
import { FiverrSource } from "./fiverr";
import { FreelancerSource } from "./freelancer";
import { MockSource } from "./mock";
import { UpworkSource } from "./upwork";
import { WebFeedSource } from "./web";

let adapters: SourceAdapter[] | undefined;

export function listSourceAdapters(): SourceAdapter[] {
  if (!adapters) {
    adapters = [new MockSource(), new UpworkSource(), new FreelancerSource(), new ContraSource(), new FiverrSource(), new WebFeedSource(), new DirectSource()];
  }
  return adapters;
}

export function getSourceAdapter(key: string): SourceAdapter | undefined {
  return listSourceAdapters().find((a) => a.key === key);
}
