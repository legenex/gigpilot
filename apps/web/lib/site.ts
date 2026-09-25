import { env } from "@gigpilot/config/env";

/** Runtime URLs. Local gx10-01 uses Tailscale URLs; production uses the canonical domains. */
export function siteUrls() {
  const e = env();
  return {
    web: e.WEB_URL,
    app: e.APP_URL,
    login: `${e.APP_URL}/login`,
    signup: `${e.APP_URL}/signup`,
    canonicalWeb: e.CANONICAL_WEB_URL,
    canonicalApp: e.CANONICAL_APP_URL,
  };
}
