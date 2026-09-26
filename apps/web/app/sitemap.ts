import type { MetadataRoute } from "next";

const base = process.env.CANONICAL_WEB_URL ?? "https://gigpilot.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-09-26");
  return [
    { url: base, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/terms`, lastModified, changeFrequency: "yearly", priority: 0.2 },
  ];
}
