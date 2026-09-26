"use server";

import { markNotificationsRead } from "@gigpilot/agents";
import { runAction } from "./run";

export async function markNotificationsReadAction(ids?: string[]) {
  return runAction("notifications.read", (ctx) => markNotificationsRead(ctx, ids?.slice(0, 200)), { revalidate: ["/"], limit: 60 });
}
