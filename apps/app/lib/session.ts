import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getSessionContext, type SessionContext } from "@gigpilot/auth";

/** Per-request memoised authoritative session (layout + page share one lookup). */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  return getSessionContext(await headers());
});

/** Server components: redirect to /login when signed out. */
export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  // Operator bootstrap: no dashboard until a permanent password is chosen.
  if (ctx.mustChangePassword) redirect("/set-password");
  return ctx;
}
