import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS } from "@/lib/demo-data";
import { LazyWorkflowDag } from "./lazy-visuals";

export function ProductionSection() {
  const L = DEFAULTS.limits;
  return (
    <Section id="production" index="05" name="Autonomous production" stage="Build · Verify" labelledBy="production-title">
      <SectionIntro
        id="production-title"
        title="Work that checks itself before you see it."
        lead="The Production Planner compiles each accepted job into a DAG of specialist steps. The QA Evaluator reviews every output independently, and when something fails, Recovery diagnoses it and repairs, regenerates or reroutes — inside hard limits."
        aside={
          <dl className="mt-6 grid grid-cols-3 gap-x-4 border-t border-line pt-4">
            {[
              [`${L.maxStepAttempts}`, "attempts per step"],
              [`${L.maxRepairsPerJob}`, "repairs per job"],
              [`$${L.perJobSpendLimitUsd}`, "spend cap per job"],
            ].map(([v, k]) => (
              <div key={k}>
                <dt className="sr-only">{k}</dt>
                <dd className="tnum font-display text-[28px] font-semibold tracking-[-0.02em] text-fg">{v}</dd>
                <dd className="label mt-1">{k}</dd>
              </div>
            ))}
          </dl>
        }
      />
      <div className="reveal mt-14 lg:mt-16">
        <LazyWorkflowDag />
      </div>
    </Section>
  );
}
