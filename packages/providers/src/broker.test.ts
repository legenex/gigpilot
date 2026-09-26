import { describe, expect, it } from "vitest";
import type { CreativeModelOption, CreativeOutput, CreativeProvider, CreativeRequest, ProviderHealth } from "@gigpilot/contracts";
import { CREATIVE_CATALOG } from "@gigpilot/economics";
import { CreativeProviderBroker } from "./broker";
import { ASPECT_DIMENSIONS, MockCreativeProvider } from "./creative/mock";
import type { CreativeGenerateOptions } from "./types";

class FakeCreative implements CreativeProvider {
  calls: { model: string; tenantId?: string }[] = [];
  constructor(
    readonly key: string,
    private readonly configured: boolean,
    readonly paid = true,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async health(): Promise<ProviderHealth> {
    return { status: "connected", detail: "fake", checkedAt: new Date().toISOString() };
  }
  models(): CreativeModelOption[] {
    return CREATIVE_CATALOG.filter((m) => m.provider === this.key);
  }
  async generate(req: CreativeRequest, option: CreativeModelOption): Promise<CreativeOutput> {
    this.calls.push({ model: option.model, tenantId: req.context?.tenantId });
    return { provider: this.key, model: option.model, status: "succeeded", files: [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/png", filename: "x.png" }], costUsd: option.unitCostUsd ?? 0, costSource: "catalog", latencyMs: 5 };
  }
}

const base = (over: Partial<CreativeGenerateOptions> = {}): CreativeGenerateOptions => ({
  tenantId: "t1",
  budget: { allowPaid: false, remainingPaidUsd: 0 },
  qualityThreshold: 0.72,
  preference: ["kie", "higgsfield"],
  ...over,
});
const request = (over: Partial<CreativeRequest> = {}): CreativeRequest => ({
  capability: "image.generate",
  prompt: "Headline: Sleep better tonight\nBrand: Solace Sleep\nCTA: Shop now",
  aspectRatio: "9:16",
  idempotencyKey: "gen:test:1:0",
  maxCostUsd: 5,
  ...over,
});

describe("CreativeProviderBroker", () => {
  it("routes to mock with the rationale of the route that would have been chosen when paid spend is disabled", () => {
    const broker = new CreativeProviderBroker([new FakeCreative("kie", true), new FakeCreative("higgsfield", true)]);
    const d = broker.plan("image.generate", base());
    expect(d.mode).toBe("mock");
    expect(d.rationale).toMatch(/would be selected \(\$\d/);
    expect(d.rationale).toMatch(/paid spend is disabled/);
    expect(d.option.provider).toBe("mock");
    expect(d.option.unitCostUsd).toBeGreaterThan(0); // simulated at the catalog price
  });

  it("explains unconfigured providers", () => {
    const broker = new CreativeProviderBroker([new FakeCreative("kie", false), new FakeCreative("higgsfield", false)]);
    expect(broker.plan("image.generate", base({ budget: { allowPaid: true, remainingPaidUsd: 10 } })).rationale).toMatch(/no creative provider is configured/);
  });

  it("picks a live, affordable route when paid spend is allowed, and reroutes via exclude", async () => {
    const kie = new FakeCreative("kie", true);
    const hf = new FakeCreative("higgsfield", true);
    const broker = new CreativeProviderBroker([kie, hf]);
    const opts = base({ budget: { allowPaid: true, remainingPaidUsd: 10 } });
    const first = broker.plan("image.generate", opts);
    expect(first.mode).toBe("live");
    const rerouted = broker.plan("image.generate", { ...opts, exclude: [{ provider: first.option.provider, model: first.option.model }] });
    expect(rerouted.mode).toBe("live");
    expect(`${rerouted.option.provider}/${rerouted.option.model}`).not.toBe(`${first.option.provider}/${first.option.model}`);

    const out = await broker.generate(request(), opts);
    expect(out.decision.mode).toBe("live");
    expect([...kie.calls, ...hf.calls][0]!.tenantId).toBe("t1");
  });

  it("never selects a paid route above the remaining budget or the per-generation cap", () => {
    const broker = new CreativeProviderBroker([new FakeCreative("kie", true), new FakeCreative("higgsfield", true)]);
    const d = broker.plan("video.generate", { ...base({ budget: { allowPaid: true, remainingPaidUsd: 0.01 } }), durationSec: 15 } as CreativeGenerateOptions);
    expect(d.mode).toBe("mock");
    expect(d.rationale).toMatch(/exceeds/);
  });

  it("honours tenant-resolved configuration", () => {
    const broker = new CreativeProviderBroker([new FakeCreative("kie", false)]);
    const d = broker.plan("image.generate", { ...base({ budget: { allowPaid: true, remainingPaidUsd: 10 } }), configuredProviders: ["kie"] } as CreativeGenerateOptions);
    expect(d.mode).toBe("live");
    expect(d.option.provider).toBe("kie");
  });

  it("mock renders real SVG files at the requested aspect ratio, and a checkable defect when asked", async () => {
    const broker = new CreativeProviderBroker([new FakeCreative("kie", false)], new MockCreativeProvider());
    const ok = await broker.generate(request(), base());
    const svg = new TextDecoder().decode(ok.files[0]!.bytes);
    expect(ok.files[0]!.mime).toBe("image/svg+xml");
    expect(svg).toContain(`width="${ASPECT_DIMENSIONS["9:16"].width}" height="${ASPECT_DIMENSIONS["9:16"].height}"`);
    expect(svg).toContain("Sleep better tonight");
    expect(ok.costSource).toBe("catalog");

    const bad = await broker.generate(request({ idempotencyKey: "gen:test:1:1" }), base({ simulateDefect: "aspect_ratio" }));
    const badSvg = new TextDecoder().decode(bad.files[0]!.bytes);
    expect(badSvg).toContain(`width="${ASPECT_DIMENSIONS["1:1"].width}" height="${ASPECT_DIMENSIONS["1:1"].height}"`);

    const video = await broker.generate(request({ capability: "video.generate", durationSec: 15, idempotencyKey: "gen:test:1:2" }), base());
    expect(video.files.map((f) => f.mime)).toEqual(["image/svg+xml", "application/json"]);
    const shots = JSON.parse(new TextDecoder().decode(video.files[1]!.bytes)) as { label: string; shots: unknown[] };
    expect(shots.label).toMatch(/MOCK STORYBOARD/);
    expect(shots.shots.length).toBeGreaterThanOrEqual(4);
  });
});
