import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS, radarRows, SOURCES } from "@/lib/demo-data";
import { RadarTable } from "./radar-table";

export function RadarSection() {
  const rows = radarRows();
  const T = DEFAULTS.thresholds;
  return (
    <Section id="radar" index="02" name="Opportunity Radar" stage="Discover · Analyse · Price" labelledBy="radar-title">
      <SectionIntro
        id="radar-title"
        title="Every permitted source. One ranked queue."
        lead={
          <>
            Official APIs where the marketplace permits them, notification parsing for Contra and Fiverr, public feeds and your own
            prospects — normalised, de-duplicated, expired after {DEFAULTS.sourcing.opportunityMaxAgeHours} hours and priced before you
            ever see them.
          </>
        }
        aside={
          <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-4 sm:grid-cols-3">
            {SOURCES.map((s) => (
              <li key={s.key} className="flex items-baseline justify-between gap-2 sm:block">
                <span className="text-[13px] text-fg">{s.label}</span>{" "}
                <span className="font-mono text-[10.5px] uppercase tracking-[0.07em] text-fg-muted sm:block">{s.mode}</span>
              </li>
            ))}
          </ul>
        }
      />

      <div className="mt-14 lg:mt-16">
        <RadarTable rows={rows} thresholds={{ margin: T.minGrossMargin, profit: T.minExpectedProfitUsd, budget: T.preferredMinBudgetUsd }} />
        <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <p className="max-w-[640px] text-[14px] leading-[22px] text-fg-muted">
            <span className="text-fg-2">Compliance-first by design.</span> No scraping, no browser automation, no CAPTCHA or rate-limit
            workarounds. Proposals are submitted only where a marketplace officially allows it — and only after you approve them.
          </p>
          <p className="label shrink-0">Illustrative rows · figures from the real calculator</p>
        </div>
      </div>
    </Section>
  );
}
