import { CountUp } from "@/components/motion/count-up";
import { DEFAULTS } from "@/lib/demo-data";

const T = DEFAULTS.thresholds;
const LIM = DEFAULTS.limits;

const STATS = [
  { value: T.minGrossMargin * 100, suffix: "%", label: "Minimum gross margin" },
  { value: T.minExpectedProfitUsd, prefix: "$", label: "Minimum expected profit" },
  { value: LIM.perJobSpendLimitUsd, prefix: "$", label: "Production spend cap per job" },
  { value: DEFAULTS.goals.ownerTouchpointsPerJob, label: "Owner approvals per job" },
  { value: 0, label: "Marketplaces scraped" },
];

const STACK = [
  { name: "Factory Router", role: "reasoning" },
  { name: "GX10 cluster", role: "local triage" },
  { name: "xAI Grok", role: "live research" },
  { name: "Kie.ai", role: "creative" },
  { name: "Higgsfield", role: "creative" },
];

/** Credibility without social proof: the operating defaults, stated as numbers. */
export function DefaultsStrip() {
  return (
    <section aria-labelledby="defaults-title" className="relative mt-10 border-y border-line">
      <h2 id="defaults-title" className="sr-only">
        Operating defaults
      </h2>
      <div className="site-container">
        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-5">
          {STATS.map((s, i) => (
            <div
              key={s.label}
              className={`flex flex-col-reverse gap-2 bg-bg py-7 sm:py-9 ${i % 2 === 1 ? "pl-5" : ""} sm:pl-6 sm:first:pl-0 sm:[&:nth-child(4)]:pl-0 lg:[&:nth-child(4)]:pl-6 ${i === 4 ? "col-span-2 pl-0 lg:col-span-1" : ""}`}
            >
              <dt className="label">{s.label}</dt>
              <dd className="tnum font-display text-[40px] font-semibold leading-none tracking-[-0.035em] text-fg sm:text-[48px]">
                <CountUp value={s.value} prefix={s.prefix} suffix={s.suffix} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="border-t border-line">
        <div className="site-container flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
          <p className="label">Defaults. Every threshold is configurable per workspace.</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5" aria-label="Providers GigPilot routes work across">
            {STACK.map((p) => (
              <li key={p.name} className="font-mono text-[11px] uppercase tracking-[0.08em]">
                <span className="text-fg-2">{p.name}</span> <span className="text-fg-muted">· {p.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
