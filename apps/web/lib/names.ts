/** Human names for providers and models on the public site (client-safe, no data imports). */
const PROVIDER_NAMES: Record<string, string> = { kie: "Kie.ai", higgsfield: "Higgsfield", factory: "Factory", gx: "GX10", grok: "xAI Grok" };

/** Human model names for the public site — catalog ids stay inside the product. */
const MODEL_NAMES: Record<string, string> = {
  "nano-banana-2": "Nano Banana 2",
  "google/imagen4-fast": "Imagen 4 Fast",
  "gpt-image-2-text-to-image": "GPT Image 2",
  "google/nano-banana-edit": "Nano Banana Edit",
  "veo-3-1": "Veo 3.1 Fast",
  "kling-3.0/video": "Kling 3.0",
  "bytedance/seedance-2-fast": "Seedance 2 Fast",
  "higgsfield-ai/soul/v2/standard": "Soul v2",
  "z-image/turbo": "Z-Image Turbo",
  "kling-video/v3.0/pro/image-to-video": "Kling 3.0 Pro",
  "bytedance/seedance-2.5/text-to-video": "Seedance 2.5",
};

export function providerName(provider: string) {
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function modelName(model: string) {
  if (MODEL_NAMES[model]) return MODEL_NAMES[model];
  const last = model.split("/").filter(Boolean).pop() ?? model;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
