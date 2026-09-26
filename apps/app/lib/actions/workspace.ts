"use server";

import { CommandError, clearSampleData } from "@gigpilot/agents";
import { runAction } from "./run";

const ALL_PATHS = ["/", "/radar", "/applications", "/jobs", "/production", "/agents", "/costs", "/markets", "/integrations", "/settings"];

/**
 * Deletes this workspace's seeded sample history (rows created before the
 * workspace existed) through the backend command — tenant-scoped, one
 * transaction, audited. Live pipeline data is never touched.
 */
export async function clearSampleDataAction() {
  return runAction(
    "workspace.clearSample",
    async (ctx) => {
      if (ctx.role !== "owner" && ctx.role !== "admin") throw new CommandError("Only owners and admins can clear sample data.", "forbidden");
      const res = await clearSampleData(ctx);
      const deleted = res.deleted as unknown;
      const rows = typeof deleted === "number" ? deleted : Object.values((deleted ?? {}) as Record<string, number>).reduce((a, b) => a + Number(b || 0), 0);
      return { rows };
    },
    { revalidate: ALL_PATHS, limit: 5 },
  );
}
