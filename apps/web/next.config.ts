import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * Content-Security-Policy (security review L1). Next 16 inlines its RSC
 * bootstrap scripts, so script-src needs 'unsafe-inline' (nonces would force
 * every page to render dynamically); React dev tooling also needs
 * 'unsafe-eval', in development only. Everything else is same-origin: fonts
 * are self-hosted by next/font, there are no third-party scripts, frames or
 * beacons. API routes set their own CSP (e.g. sandboxed asset previews).
 */
const dev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // The monorepo keeps one canonical AGENTS.md at the root.
  agentRules: false,
  serverExternalPackages: ["pg-boss", "postgres"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Pages only — route handlers under /api set their own CSP where it matters.
      { source: "/((?!api/).*)", headers: [{ key: "Content-Security-Policy", value: csp }] },
    ];
  },
};

export default nextConfig;
