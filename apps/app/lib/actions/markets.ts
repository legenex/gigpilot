"use server";

import { z } from "zod";
import { applyMarketRecommendation, updateMarket } from "@gigpilot/agents";
import { runAction } from "./run";

const PATHS = ["/", "/markets"];

export async function setMarketEnabledAction(marketKey: string, enabled: boolean) {
  return runAction("market.toggle", (ctx) => updateMarket(ctx, marketKey, { enabled }), { revalidate: PATHS, message: enabled ? "Market enabled" : "Market paused" });
}

const allocationSchema = z.array(z.object({ key: z.string().min(1).max(80), allocationPct: z.number().min(0).max(100) })).max(40);

export async function saveAllocationsAction(allocations: { key: string; allocationPct: number }[]) {
  return runAction(
    "market.allocations",
    async (ctx) => {
      const rows = allocationSchema.parse(allocations);
      for (const r of rows) await updateMarket(ctx, r.key, { allocationPct: Math.round(r.allocationPct * 10) / 10 });
    },
    { revalidate: PATHS, message: "Sourcing allocation saved" },
  );
}

export async function applyRecommendationAction(insightId: string) {
  return runAction("market.apply", (ctx) => applyMarketRecommendation(ctx, insightId), { revalidate: PATHS, limit: 10, message: "Recommendation applied to allocation" });
}
