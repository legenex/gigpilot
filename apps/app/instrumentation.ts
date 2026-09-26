/**
 * Next.js server start hook: surface deployment-policy warnings (open sign-up
 * on a public URL, ignored "@domain" invite entries, unregistered operator
 * emails) in the logs at boot instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { logAuthStartupWarnings } = await import("@gigpilot/auth");
    logAuthStartupWarnings();
  } catch {
    /* diagnostics must never block startup */
  }
}
