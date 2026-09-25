import { getSessionCookie } from "better-auth/cookies";

/** Cookie prefix shared by every GigPilot app (must match server config). */
export const COOKIE_PREFIX = "gigpilot";

/**
 * Optimistic presence check for Next.js proxy (middleware). NOT a security
 * boundary — pages and actions must call getSessionContext().
 */
export function hasSessionCookie(request: Request | Headers): boolean {
  return Boolean(getSessionCookie(request, { cookiePrefix: COOKIE_PREFIX }));
}
