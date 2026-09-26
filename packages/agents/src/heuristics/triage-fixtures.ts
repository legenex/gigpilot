/**
 * Triage evaluation set: realistic briefs with the production capabilities
 * the deterministic triage MUST extract, whether the estimate must come out
 * incomplete (a modality with no priced route) and the stated deadline.
 * Used by triage-eval.test.ts; extend it whenever a triage miss is found.
 */
export interface TriageFixture {
  key: string;
  title: string;
  description: string;
  budget: { type: "fixed" | "hourly"; min: number; max: number };
  /** Capabilities that must appear in productionEstimates. */
  capabilities: string[];
  /** true → the estimate must be flagged incomplete (unpriced modality). */
  incomplete: boolean;
  /** Expected deadline in days (null = none stated); "by <date>" fixtures are computed from `now`. */
  deadlineDays: number | null;
  /** Service family triage should assign. */
  family?: string;
  /** Video label must carry this duration. */
  durationSec?: number;
  /** Features that must be detected (code briefs). */
  features?: string[];
  /** Brief explicitly requires tests. */
  requiresTests?: boolean;
}

export const TRIAGE_NOW = new Date("2026-09-26T12:00:00Z");

export const TRIAGE_FIXTURES: TriageFixture[] = [
  {
    key: "explainer-voiceover",
    title: "60s animated explainer video for our fintech app",
    description:
      "Brief: 60s animated explainer with voiceover, 16:9 + 9:16, 14 days. It explains our budgeting app to first-time users. " +
      "Script outline and brand kit (logo, colours, fonts) supplied. Motion graphics style, friendly tone, clear CTA at the end.",
    budget: { type: "fixed", min: 1500, max: 2500 },
    capabilities: ["video.generate", "audio.voiceover"],
    incomplete: true,
    deadlineDays: 14,
    family: "paid-social-ugc",
    durationSec: 60,
  },
  {
    key: "ugc-tiktok",
    title: "UGC-style TikTok ads for our sleep gummies launch (10 videos)",
    description:
      "We're launching sleep gummies and need 10 UGC-style videos, 15s each, 9:16 for TikTok and Reels. We supply product shots and brand guidelines (fonts, colours, logo). " +
      "Native, creator-to-camera feel. Deliver within 9 days.",
    budget: { type: "fixed", min: 1200, max: 1800 },
    capabilities: ["video.generate"],
    incomplete: false,
    deadlineDays: 9,
    family: "paid-social-ugc",
    durationSec: 15,
  },
  {
    key: "podcast-music",
    title: "Podcast intro music + editing for 8 episodes",
    description:
      "Looking for an editor to clean up 8 recorded podcast episodes (45 min each), add an original intro music sting and sound design between segments. " +
      "Raw recordings supplied. 2 weeks turnaround.",
    budget: { type: "fixed", min: 800, max: 1200 },
    capabilities: ["audio.music"],
    incomplete: true,
    deadlineDays: 14,
  },
  {
    key: "dubbing-spanish",
    title: "Dub 6 product videos into Spanish",
    description:
      "We have 6 product videos (2 min each) in English and need them dubbed into Spanish with natural voice talent, plus SRT subtitles. Transcripts and project files supplied. Deadline 10 days.",
    budget: { type: "fixed", min: 1000, max: 1600 },
    capabilities: ["audio.dub"],
    incomplete: true,
    deadlineDays: 10,
    family: "localization-repurposing",
  },
  {
    key: "3d-render",
    title: "3D product renders for our new espresso machine",
    description:
      "Need photoreal 3D renders of our espresso machine: 6 angles on white plus 2 lifestyle kitchen scenes. CAD files supplied. Blender or similar. Deliver in 12 days.",
    budget: { type: "fixed", min: 900, max: 1400 },
    capabilities: ["model.3d"],
    incomplete: true,
    deadlineDays: 12,
  },
  {
    key: "client-portal",
    title: "MVP: client portal with Stripe billing for a design agency",
    description:
      "Build an MVP client portal for our design agency: magic-link login, document upload/download, request tracking, and Stripe subscription billing with customer portal. " +
      "Stack: Next.js + Supabase (Postgres, storage). Wireframes supplied. Include tests for billing webhooks and a deployment guide. Timeline 28 days.",
    budget: { type: "fixed", min: 4000, max: 6000 },
    capabilities: ["code.build"],
    incomplete: false,
    deadlineDays: 28,
    family: "web-app-builds",
    features: ["Stripe billing", "Magic-link login", "Document upload", "Webhook tests", "Request tracking"],
    requiresTests: true,
  },
  {
    key: "n8n-sync",
    title: "Shopify → HubSpot order & customer sync in n8n",
    description:
      "We need a reliable Shopify → HubSpot sync built in our self-hosted n8n. Requirements: webhook triggers, dedupe contacts by email, retry with backoff on 429s, Slack alert on failures, README + runbook. " +
      "Access to a staging store and HubSpot sandbox provided. Deliver in 10 days.",
    budget: { type: "fixed", min: 2400, max: 2400 },
    capabilities: ["code.automation"],
    incomplete: false,
    deadlineDays: 10,
    family: "ai-automation",
    features: ["Webhook handling", "Deduplication", "Retry with backoff", "Slack alerts", "README", "Runbook"],
    requiresTests: false,
  },
  {
    key: "product-photos",
    title: "25 product images: white-background cleanup + lifestyle composites",
    description:
      "We sell ceramic homeware on Shopify and need 25 product images: white-background cleanup for 15 SKUs plus 10 lifestyle composites. Output: 2048×2048 PNG/JPG. " +
      "We supply the raw photos and 5 mood references. Deadline 7 days.",
    budget: { type: "fixed", min: 800, max: 900 },
    capabilities: ["image.edit", "image.generate"],
    incomplete: false,
    deadlineDays: 7,
    family: "image-design",
  },
  {
    key: "subtitles",
    title: "Localise 10 tutorial videos into Spanish, German and French (subtitles)",
    description:
      "We have 10 product tutorial videos in English. Need SRT subtitles in Spanish, German and French. We provide English transcripts and a glossary of 40 brand terms. Deadline 10 days.",
    budget: { type: "fixed", min: 1200, max: 1500 },
    capabilities: ["text.translate"],
    incomplete: false,
    deadlineDays: 10,
    family: "localization-repurposing",
  },
  {
    key: "research-weeks",
    title: "Market research: DTC pet food competitor landscape (15 brands)",
    description:
      "Competitor landscape of 15 DTC pet food brands: positioning, pricing tiers, channels, ad angles and review themes. Deliver a report with an executive summary and 5 recommendations in 2 weeks.",
    budget: { type: "fixed", min: 1200, max: 1500 },
    capabilities: ["text.research"],
    incomplete: false,
    deadlineDays: 14,
    family: "research-content",
  },
  {
    key: "logo-animation-date",
    title: "Logo animation (motion graphics) for our brand launch",
    description:
      "We need a 10s logo animation with motion graphics for our launch video, 16:9. Vector logo supplied. Needed by October 12.",
    budget: { type: "fixed", min: 400, max: 700 },
    capabilities: ["video.generate"],
    incomplete: false,
    deadlineDays: 16,
    durationSec: 10,
  },
  {
    key: "elearning-narration",
    title: "Professional narration for an e-learning course",
    description:
      "Looking for voice-over narration for a 12-module e-learning course (about 90 minutes of script in total). Scripts supplied as Google Docs. Deliver within 3 weeks.",
    budget: { type: "fixed", min: 700, max: 1100 },
    capabilities: ["audio.voiceover"],
    incomplete: true,
    deadlineDays: 21,
  },
  {
    key: "whiteboard-music",
    title: "90-second whiteboard explainer with background music",
    description:
      "Need a 90-second whiteboard video explaining our logistics platform, with licensed background music and captions. 16:9. Script ready. Deadline 10 days.",
    budget: { type: "fixed", min: 1000, max: 1500 },
    capabilities: ["video.generate", "audio.music"],
    incomplete: true,
    deadlineDays: 10,
    durationSec: 90,
  },
];
