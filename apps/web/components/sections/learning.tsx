import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS } from "@/lib/demo-data";
import { LazyLearningChart } from "./lazy-visuals";

const SIGNALS = [
  { k: "Cost estimates", from: "±34%", to: "±11%", note: `median error over 40 jobs · target ≤ ${DEFAULTS.goals.costEstimateAccuracyPct}%` },
  { k: "Route priors", from: "60%", to: "71%", note: "kie/veo-3-1 usable rate · observed after 146 generations" },
  { k: "Sourcing weights", from: "25%", to: "31%", note: "AI automation share of search effort" },
];

export function LearningSection() {
  return (
    <Section id="learning" index="08" name="Learning" stage="Learn" labelledBy="learning-title" className="pb-24 sm:pb-28 lg:pb-32">
      <SectionIntro
        id="learning-title"
        title="Every job makes the next one cheaper to find and faster to deliver."
        lead="Actual spend, usable-output rates, QA outcomes and win/loss results flow back into the system. Estimates get tighter, routes get cheaper, and sourcing moves toward the work that actually clears your gates."
      />
      <div className="mt-14 grid gap-12 lg:mt-16 lg:grid-cols-12 lg:gap-6">
        <div className="reveal lg:col-span-7">
          <p className="label mb-4 border-b border-line pb-3">Cost-estimate error by completed job · illustrative</p>
          <LazyLearningChart />
        </div>
        <dl className="reveal-late divide-y divide-line self-end border-y border-line lg:col-span-4 lg:col-start-9">
          {SIGNALS.map((s) => (
            <div key={s.k} className="py-5">
              <dt className="label">{s.k}</dt>
              <dd className="mt-2 flex items-baseline gap-3">
                <span className="tnum font-mono text-[15px] text-fg-muted line-through decoration-fg-4">{s.from}</span>
                <span aria-hidden className="text-fg-muted">→</span>
                <span className="tnum font-display text-[32px] font-semibold leading-none tracking-[-0.03em] text-fg">{s.to}</span>
              </dd>
              <dd className="mt-2 text-[13px] leading-[19px] text-fg-muted">{s.note}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
