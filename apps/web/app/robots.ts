import type { MetadataRoute } from "next";

const base = process.env.CANONICAL_WEB_URL ?? "https://gigpilot.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
