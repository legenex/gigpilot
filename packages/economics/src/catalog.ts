import type { Capability, CreativeModelOption } from "@gigpilot/contracts";

/**
 * Deterministic price catalog. Values come from official pricing pages read
 * on PRICE_VERIFIED_AT (see docs/research/providers.md). `unitCostUsd: null`
 * means the price is unknown and any estimate using it is marked incomplete.
 *
 * Creative quality/usable-rate priors are starting beliefs; the broker
 * replaces them with observed provider_metric data as jobs complete.
 */
export const PRICE_VERIFIED_AT = "2026-09-26";

const KIE_CREDIT_USD = 0.005;

export const CREATIVE_CATALOG: CreativeModelOption[] = [
  // --- Kie.ai (cost-sensitive primary) ---
  { provider: "kie", model: "nano-banana-2", capability: "image.generate", unitCostUsd: 8 * KIE_CREDIT_USD, unit: "image", qualityPrior: 0.84, usableRatePrior: 0.72, avgLatencySec: 25, priceVerifiedAt: PRICE_VERIFIED_AT, notes: "1K resolution" },
  { provider: "kie", model: "google/imagen4-fast", capability: "image.generate", unitCostUsd: 4 * KIE_CREDIT_USD, unit: "image", qualityPrior: 0.74, usableRatePrior: 0.66, avgLatencySec: 15, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "kie", model: "gpt-image-2-text-to-image", capability: "image.generate", unitCostUsd: 6 * KIE_CREDIT_USD, unit: "image", qualityPrior: 0.82, usableRatePrior: 0.7, avgLatencySec: 40, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "kie", model: "google/nano-banana-edit", capability: "image.edit", unitCostUsd: 4 * KIE_CREDIT_USD, unit: "image", qualityPrior: 0.78, usableRatePrior: 0.7, avgLatencySec: 20, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "kie", model: "topaz/image-upscale", capability: "image.upscale", unitCostUsd: null, unit: "image", qualityPrior: 0.85, usableRatePrior: 0.9, avgLatencySec: 30, notes: "price not captured" },
  { provider: "kie", model: "veo-3-1", capability: "video.generate", unitCostUsd: 60 * KIE_CREDIT_USD, unit: "clip", qualityPrior: 0.86, usableRatePrior: 0.6, avgLatencySec: 120, priceVerifiedAt: PRICE_VERIFIED_AT, notes: "Fast tier, 720p, ~8s clip" },
  { provider: "kie", model: "kling-3.0/video", capability: "video.image_to_video", unitCostUsd: 14 * KIE_CREDIT_USD, unit: "second", qualityPrior: 0.8, usableRatePrior: 0.62, avgLatencySec: 150, priceVerifiedAt: PRICE_VERIFIED_AT, notes: "720p, no audio" },
  { provider: "kie", model: "bytedance/seedance-2-fast", capability: "video.generate", unitCostUsd: 11.7 * KIE_CREDIT_USD, unit: "second", qualityPrior: 0.76, usableRatePrior: 0.6, avgLatencySec: 90, priceVerifiedAt: PRICE_VERIFIED_AT, notes: "lowest tier" },
  // --- Higgsfield (premium / fallback) ---
  { provider: "higgsfield", model: "higgsfield-ai/soul/v2/standard", capability: "image.generate", unitCostUsd: 0.0032, unit: "image", qualityPrior: 0.86, usableRatePrior: 0.74, avgLatencySec: 30, priceVerifiedAt: PRICE_VERIFIED_AT, notes: "may include launch discount" },
  { provider: "higgsfield", model: "z-image/turbo", capability: "image.generate", unitCostUsd: 0.015, unit: "image", qualityPrior: 0.72, usableRatePrior: 0.68, avgLatencySec: 12, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "higgsfield", model: "kling-video/v3.0/pro/image-to-video", capability: "video.image_to_video", unitCostUsd: 0.0462, unit: "second", qualityPrior: 0.88, usableRatePrior: 0.7, avgLatencySec: 160, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "higgsfield", model: "bytedance/seedance-2.5/text-to-video", capability: "video.generate", unitCostUsd: 0.144, unit: "second", qualityPrior: 0.9, usableRatePrior: 0.72, avgLatencySec: 140, priceVerifiedAt: PRICE_VERIFIED_AT },
  { provider: "higgsfield", model: "marketing-studio/image", capability: "image.edit", unitCostUsd: null, unit: "image", qualityPrior: 0.87, usableRatePrior: 0.75, avgLatencySec: 40, notes: "use /estimate before generating" },
];

/** Per-1M-token prices (USD). GX is local compute: cost recorded as $0 ("free"). */
export interface InferencePrice {
  family: "factory" | "gx" | "grok";
  model: string;
  inputPerM: number | null;
  outputPerM: number | null;
  source: string;
}

export const INFERENCE_CATALOG: InferencePrice[] = [
  { family: "gx", model: "gx-mini", inputPerM: 0, outputPerM: 0, source: "local GX10 compute" },
  { family: "gx", model: "gx-code", inputPerM: 0, outputPerM: 0, source: "local GX10 compute" },
  { family: "gx", model: "gx-auto", inputPerM: 0, outputPerM: 0, source: "local GX10 compute" },
  { family: "grok", model: "grok-4.3", inputPerM: 1.25, outputPerM: 2.5, source: `docs.x.ai pricing ${PRICE_VERIFIED_AT}` },
  { family: "grok", model: "grok-4.7", inputPerM: 2, outputPerM: 6, source: `docs.x.ai pricing ${PRICE_VERIFIED_AT}` },
  // Factory bills in Standard Credits (tokens × model multiplier). "auto" is treated
  // at a Sonnet-class 1x planning rate until real usage data replaces it.
  { family: "factory", model: "auto", inputPerM: 3, outputPerM: 15, source: "planning assumption (1x Factory token rate)" },
];

/** Grok server-side web search is billed per call. */
export const GROK_WEB_SEARCH_PER_CALL_USD = 0.005;

export function inferencePrice(family: string, model: string): InferencePrice | undefined {
  return INFERENCE_CATALOG.find((p) => p.family === family && p.model === model) ?? INFERENCE_CATALOG.find((p) => p.family === family);
}

export function inferenceCostUsd(family: string, model: string, inputTokens: number, outputTokens: number): number | null {
  const p = inferencePrice(family, model);
  if (!p || p.inputPerM === null || p.outputPerM === null) return null;
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

export function creativeOptionsFor(capability: Capability, catalog: CreativeModelOption[] = CREATIVE_CATALOG): CreativeModelOption[] {
  return catalog.filter((o) => o.capability === capability);
}

/** Typical units per deliverable used to translate "one 15s video" into billable units. */
export function unitsFor(option: CreativeModelOption, durationSec = 8): number {
  if (option.unit === "second") return durationSec;
  if (option.unit === "minute") return durationSec / 60;
  return 1;
}

/** Default length of one generated clip when the catalog note does not state it (seconds). */
export const DEFAULT_CLIP_SECONDS = 8;

/** Clip length of a per-clip route (from its catalog note, e.g. "~8s clip"). */
export function clipSecondsOf(option: CreativeModelOption): number {
  const m = /~?\s*(\d{1,3})\s*s\s*clip/i.exec(option.notes ?? "");
  const n = m ? Number(m[1]) : DEFAULT_CLIP_SECONDS;
  return n > 0 ? n : DEFAULT_CLIP_SECONDS;
}

/**
 * Billable units for ONE finished deliverable of `durationSec` (estimation): per-clip routes
 * need ceil(duration / clip length) clips, so a 60s explainer is never priced as one 8s clip.
 */
export function deliverableUnitsFor(option: CreativeModelOption, durationSec?: number): number {
  if (option.unit === "clip" && durationSec !== undefined && durationSec > 0) return Math.max(1, Math.ceil(durationSec / clipSecondsOf(option)));
  return unitsFor(option, durationSec);
}
