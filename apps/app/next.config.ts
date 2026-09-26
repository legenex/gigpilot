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

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // The repo root AGENTS.md is canonical; don't let `next dev` generate per-app copies.
  agentRules: false,
  devIndicators: { position: "bottom-right" },
  serverExternalPackages: ["pg-boss", "postgres"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
