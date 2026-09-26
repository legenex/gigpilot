import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS, radarRows } from "@/lib/demo-data";
import { LazyProfitCalculator } from "./lazy-visuals";
import type { Preset } from "./profit-calculator";

const PRESETS: { id: string; label: string }[] = [
  { id: "op_7f3a", label: "UGC ads" },
  { id: "op_91be", label: "Localization" },
  { id: "op_a7d0", label: "Content" },
  { id: "op_e8a2", label: "Photo set" },
];

export function EconomicsSection() {
  const rows = radarRows();
  const presets: Preset[] = PRESETS.flatMap(({ id, label }) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return [];
    const market = (["upwork", "freelancer", "fiverr", "contra", "direct"] as const).find((m) => m === r.source.key) ?? "direct";
    return [{ id, label, budget: r.priceUsd, production: r.fulfilmentUsd, hours: r.shadowUsd / DEFAULTS.economics.shadowHourlyRateUsd, market }];
  });

  return (
    <Section id="economics" index="04" name="Profitability scoring" stage="Price" labelledBy="economics-title">
      <SectionIntro
        center
        id="economics-title"
        title="Models estimate. The calculator decides."
        lead="LLMs estimate quantities — images, clip seconds, tokens, attempts. Every dollar comes from a deterministic calculator and a price catalog with verification dates. Unknown price? The estimate is marked incomplete, never guessed."
        aside={
          <p className="reveal-late mt-8 font-mono text-[13px] leading-[24px] text-fg-muted sm:text-[14px]" aria-label="profit equals price minus production, revisions, contingency, owner time and fees">
            <span className="text-profit">profit</span> = <span className="text-fg">price</span> − ( <span className="text-violet">production</span> +{" "}
            <span className="text-warn">revisions</span> + <span className="text-warn">contingency</span> + <span className="text-info">owner time</span> +{" "}
            <span className="text-fg-2">fees</span> )
          </p>
        }
      />
      <div className="reveal mt-14 lg:mt-16">
        <LazyProfitCalculator presets={presets} />
      </div>
    </Section>
  );
}
