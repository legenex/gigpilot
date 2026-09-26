import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS } from "@/lib/demo-data";
import { learningSummary } from "@/lib/learning";
import { LazyLearningChart } from "./lazy-visuals";

const summary = learningSummary();

// Illustrative figures. The mechanisms are real: provider metrics and usable rates are tracked per route,
// and estimated vs actual cost is recorded per job; the numbers here are a worked example.
const SIGNALS = [
  {
    k: "Cost-estimate error",
    from: `±${summary.first}%`,
    to: `±${summary.last}%`,
    note: `median, first vs last ${summary.window} jobs · estimate compared with actual per job · target ≤ ${DEFAULTS.goals.costEstimateAccuracyPct}%`,
  },
  { k: "Route usable rate", from: "60%", to: "71%", note: "Veo 3.1 Fast via Kie.ai · catalog prior → observed rate, used once a route has 5+ attempts" },
  { k: "Sourcing allocation", from: "25%", to: "31%", note: "AI automation & agents · recommended share of search effort — you approve the change" },
];

export function LearningSection() {
  return (
    <Section id="learning" index="08" name="Learning" stage="Learn" labelledBy="learning-title" className="pb-24 sm:pb-28 lg:pb-32">
      <SectionIntro
        id="learning-title"
        title="Every finished job feeds the next decision."
        lead="Actual spend, usable-output rates, QA outcomes and win/loss results are recorded for every job. Estimated and actual cost are compared job by job, observed usable rates replace catalog priors once a route has enough attempts, and Market Research can recommend moving sourcing toward the work that clears your gates."
      />
      <div className="mt-14 grid gap-12 lg:mt-16 lg:grid-cols-12 lg:gap-6">
        <div className="reveal lg:col-span-7">
          <p className="label mb-4 border-b border-line pb-3">Cost-estimate error by completed job · illustrative</p>
          <LazyLearningChart target={DEFAULTS.goals.costEstimateAccuracyPct} />
        </div>
        <div className="reveal-late self-end lg:col-span-4 lg:col-start-9">
          <p className="label border-b border-line pb-3">How it learns · illustrative figures</p>
          <dl className="divide-y divide-line border-b border-line">
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
      </div>
    </Section>
  );
}
