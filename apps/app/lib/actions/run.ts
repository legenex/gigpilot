import "server-only";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { CommandError, type CommandContext } from "@gigpilot/agents";
import { getSessionContext } from "@gigpilot/auth";
import { InvalidTransitionError } from "@gigpilot/contracts";
import { rateLimit } from "../rate-limit";

import type { ActionResult } from "./types";

export type { ActionResult };

/** Translate domain errors into owner-friendly copy. Never leaks internals. */
export function friendlyError(err: unknown): string {
  if (err instanceof CommandError) return err.message;
  if (err instanceof ZodError) {
    const i = err.issues[0];
    if (!i) return "Some fields are invalid.";
    const path = i.path.join(".");
    return path ? `${humanPath(path)}: ${i.message}` : i.message;
  }
  if (err instanceof InvalidTransitionError) {
    return `This ${err.machine} is already ${err.from.replace(/_/g, " ")} — it can't move to ${err.to.replace(/_/g, " ")}. Refresh to see the latest state.`;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "ConcurrentTransitionError") return "Someone (or an agent) changed this at the same moment. Refresh and try again.";
  if (name === "NotFoundError") return "That item no longer exists.";
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|pg-boss|queue/i.test(msg)) return "Your change was saved. Background processing couldn't be scheduled right now — it will retry automatically.";
  return "Something went wrong. Please try again.";
}

function humanPath(p: string): string {
  return p.replace(/\./g, " › ").replace(/([A-Z])/g, " $1").toLowerCase();
}

/**
 * Standard server-action wrapper: authoritative session → rate limit →
 * command → revalidate. The tenant always comes from the session, never
 * from client input.
 */
export async function runAction<T>(
  name: string,
  fn: (ctx: CommandContext) => Promise<T>,
  opts: { revalidate?: string[]; limit?: number; windowMs?: number; message?: string } = {},
): Promise<ActionResult<T>> {
  const session = await getSessionContext(await headers());
  if (!session) return { ok: false, error: "Your session expired. Sign in again." };
  if (session.mustChangePassword) return { ok: false, error: "Choose your password first — then the workspace unlocks." };
  const rl = rateLimit(`action:${session.user.id}:${name}`, opts.limit ?? 30, opts.windowMs ?? 60_000);
  if (!rl.ok) return { ok: false, error: `Too many requests — try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` };
  const ctx: CommandContext = { tenantId: session.tenantId, userId: session.user.id, role: session.role };
  try {
    const data = await fn(ctx);
    for (const p of opts.revalidate ?? []) revalidatePath(p, p.includes("[") ? "page" : undefined);
    return { ok: true, data, message: opts.message };
  } catch (err) {
    if (!(err instanceof CommandError) && !(err instanceof ZodError)) {
      console.error(JSON.stringify({ level: "error", msg: "action failed", action: name, error: err instanceof Error ? err.message : String(err) }));
    }
    return { ok: false, error: friendlyError(err) };
  }
}
