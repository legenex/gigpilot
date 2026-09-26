import { Section, SectionIntro } from "@/components/site/section";
import { allocation } from "@/lib/demo-data";
import { AllocationShift } from "./allocation-shift";

const EVIDENCE = [
  { k: "Comparable jobs cleared gates", v: "14", d: "last 14 days" },
  { k: "Median expected profit", v: "$1,420", d: "AI automation" },
  { k: "Demand", v: "+18%", d: "week over week" },
  { k: "Sources cited", v: "12", d: "Grok live research" },
];

export function MarketSection() {
  return (
    <Section id="market" index="03" name="Market intelligence" stage="Learn → Discover" labelledBy="market-title">
      <SectionIntro
        id="market-title"
        title="Know where the margin is before you go looking."
        lead="The Market Research agent tracks demand, pricing and fulfilment cost across six service families, then recommends how to split sourcing effort. Grok handles live web research, and every recommendation cites its evidence."
      />

      <div className="mt-14 grid gap-12 lg:mt-16 lg:grid-cols-12 lg:gap-6">
        <div className="reveal lg:col-span-7">
          <AllocationShift rows={allocation()} focus="ai-automation" />
        </div>

        <figure className="reveal-late relative m-0 lg:col-span-4 lg:col-start-9">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-6 items-center justify-center rounded-xs bg-surface-2 font-mono text-[10px] text-fg-2 ring-1 ring-inset ring-line-strong">
              MR
            </span>
            <figcaption className="label leading-4">
              <span className="text-fg-2">Market Research agent</span>
              <span className="block">market.insight · 06:00 run · confidence 0.78</span>
            </figcaption>
          </div>
          <blockquote className="mt-5 border-l-2 border-accent pl-5 font-display text-[21px] font-medium leading-[30px] tracking-[-0.015em] text-fg">
            “Move six points into AI automation. Fourteen comparable jobs cleared the 50% margin gate in the last two weeks; localisation
            cleared three, with dubbing costs compressing margin.”
          </blockquote>
          <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-line ring-1 ring-line">
            {EVIDENCE.map((e) => (
              <div key={e.k} className="bg-bg px-3.5 py-3">
                <dt className="font-mono text-[10px] uppercase leading-[14px] tracking-[0.07em] text-fg-muted">{e.k}</dt>
                <dd className="mt-1.5">
                  <span className="font-display text-[22px] font-semibold tracking-[-0.02em] text-fg">{e.v}</span>
                  <span className="ml-2 text-[12px] text-fg-muted">{e.d}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[13px] leading-5 text-fg-muted">Allocation is a per-workspace setting. The agent recommends; you decide in Market Lab.</p>
        </figure>
      </div>
    </Section>
  );
}
