import { DEFAULTS } from "@/lib/demo-data";

const T = DEFAULTS.thresholds;
const LIM = DEFAULTS.limits;

// Static by design: these are configuration values, so they render final on the server
// and never animate (counting up a threshold explains nothing).
const STATS = [
  { value: `${Math.round(T.minGrossMargin * 100)}%`, label: "Minimum gross margin" },
  { value: `$${T.minExpectedProfitUsd.toLocaleString("en-US")}`, label: "Minimum expected profit" },
  { value: `$${LIM.perJobSpendLimitUsd.toLocaleString("en-US")}`, label: "Production spend cap per job" },
  { value: String(DEFAULTS.goals.ownerTouchpointsPerJob), label: "Owner approvals per job" },
  { value: "0", label: "Marketplaces scraped" },
];

const STACK = [
  { name: "GX10", role: "local models" },
  { name: "Factory Router", role: "reasoning" },
  { name: "xAI Grok", role: "live research" },
  { name: "Kie.ai + Higgsfield", role: "creative" },
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
              className={`flex flex-col items-start bg-bg py-7 sm:py-9 ${i % 2 === 1 ? "pl-5" : ""} sm:pl-6 sm:first:pl-0 sm:[&:nth-child(4)]:pl-0 lg:[&:nth-child(4)]:pl-6 ${i === 4 ? "col-span-2 pl-0 lg:col-span-1" : ""}`}
            >
              {/* Number first visually (label below), top-aligned so a two-line label never lifts it off the baseline. */}
              <dt className="label order-2 mt-2.5 pr-3">{s.label}</dt>
              <dd className="tnum order-1 font-display text-[40px] font-semibold leading-none tracking-[-0.035em] text-fg sm:text-[48px]">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="border-t border-line">
        <div className="site-container grid gap-x-6 gap-y-3 py-4 lg:grid-cols-12 lg:items-start">
          <p className="label lg:col-span-4">Defaults. Every threshold is configurable per workspace.</p>
          <div className="lg:col-span-8 lg:justify-self-end">
            <ul className="flex flex-wrap gap-x-5 gap-y-1.5 lg:justify-end" aria-label="Providers GigPilot can route work to, once connected">
              {STACK.map((p) => (
                <li key={p.name} className="font-mono text-[11px] uppercase tracking-[0.08em]">
                  <span className="text-fg-2">{p.name}</span> <span className="text-fg-muted">· {p.role}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12px] leading-[18px] text-fg-muted lg:text-right">Each provider is used only once it is connected; paid ones stay off until you enable spend.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
