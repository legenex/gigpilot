import { Section } from "@/components/site/section";
import { DEFAULTS } from "@/lib/demo-data";

const L = DEFAULTS.limits;

const TIMELINE: (
  | { kind: "auto"; text: string; meta: string }
  | { kind: "gate"; n: string; title: string; body: string; mock: { line: string; meta: string; secondary: string; primary: string } }
)[] = [
  { kind: "auto", text: "Discover, analyse, price", meta: "27 viable today · 23 filtered without you" },
  {
    kind: "gate",
    n: "1",
    title: "Which opportunities",
    body: "You see a short, priced list with the reasons behind every recommendation. Nothing is pursued until you say so.",
    mock: { line: "Meta ad creative sprint — 12 UGC variants", meta: "Upwork · $1,665 expected profit · 79% margin", secondary: "Skip", primary: "Pursue" },
  },
  { kind: "auto", text: "Proposal drafted", meta: "scope · price · timeline · 38s" },
  {
    kind: "gate",
    n: "2",
    title: "Commercial commitment",
    body: "Price, scope and timeline are yours to approve or edit. Submission is automatic only where a marketplace officially permits it.",
    mock: { line: "Proposal · $2,100 fixed · 5-day delivery", meta: "12 variants · 1 revision round included", secondary: "Edit", primary: "Approve & submit" },
  },
  { kind: "auto", text: "Plan, produce, QA, repair", meta: `5 steps · 1 repair · $10.18 of $${L.perJobSpendLimitUsd}` },
  {
    kind: "gate",
    n: "3",
    title: "Final delivery",
    body: "Only work that passed independent QA reaches you. You decide what ships to the client.",
    mock: { line: "Delivery · 12 of 12 cuts passed QA", meta: "14 files · captions · delivery note drafted", secondary: "Request changes", primary: "Approve delivery" },
  },
  { kind: "auto", text: "Deliver and learn", meta: "outcome recorded · estimates recalibrated" },
];

const NEVER = [
  ["Client messages", "Drafted for you. Auto-send is off by default."],
  ["Marketplace submissions", "Only where officially permitted, and only after approval."],
  ["Paid spend", "$0 per day until you raise the limit."],
  ["Pricing and legal commitments", "Always a human decision."],
];

export function SupervisionSection() {
  return (
    <Section id="supervision" index="07" name="Human supervision" stage="Pursue · Deliver" labelledBy="supervision-title">
      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-14 lg:mt-14 lg:grid-cols-12 lg:gap-6">
        <div className="lg:sticky lg:top-28 lg:col-span-5 lg:self-start">
          <h2 id="supervision-title" className="display-2 reveal">
            You sign off three times. Not three hundred.
          </h2>
          <p className="reveal-late mt-6 text-[17px] leading-[28px] text-fg-2 lg:text-lead">
            GigPilot runs on its own between three approval points. Everything else happens inside limits you set, with every state change
            written to an audit trail.
          </p>
          <div className="mt-10">
            <p className="label border-b border-line pb-3">Never without you</p>
            <dl className="divide-y divide-line">
              {NEVER.map(([k, v]) => (
                <div key={k} className="grid gap-1 py-3.5 sm:grid-cols-[200px_1fr] sm:gap-4">
                  <dt className="text-[14px] text-fg">{k}</dt>
                  <dd className="text-[14px] leading-[21px] text-fg-muted">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="label mt-8 border-b border-line pb-3">Inside limits you set</p>
            <p className="tnum mt-3.5 font-mono text-[12.5px] leading-[22px] text-fg-2">
              ${L.perJobSpendLimitUsd} per job · {L.maxStepAttempts} attempts per step · {L.maxRepairsPerJob} repairs per job · {L.maxGenerationsPerStep}{" "}
              generations per step
            </p>
          </div>
        </div>

        <ol className="relative lg:col-span-6 lg:col-start-7" aria-label="Where you approve during a job">
          <span aria-hidden className="absolute bottom-4 left-[7px] top-4 w-px bg-line-strong" />
          {TIMELINE.map((item, i) =>
            item.kind === "auto" ? (
              <li key={i} className="relative grid grid-cols-[15px_minmax(0,1fr)] gap-x-6 py-5">
                <span aria-hidden className="relative z-[1] mt-[7px] ml-[4px] block size-[7px] rounded-full border border-fg-3 bg-bg" />
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">auto</span>
                  <span className="text-[14px] text-fg-2">{item.text}</span>
                  <span className="font-mono text-[11.5px] text-fg-muted">{item.meta}</span>
                </p>
              </li>
            ) : (
              <li key={i} className="reveal relative grid grid-cols-[15px_minmax(0,1fr)] gap-x-6 py-6">
                <span aria-hidden className="relative z-[1] mt-[6px] block size-[11px] translate-x-[2px] rotate-45 border-[1.5px] border-accent bg-bg" />
                <div>
                  <p className="flex items-baseline gap-3">
                    <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-accent-hi">Approval {item.n} of 3</span>
                  </p>
                  <h3 className="display-3 mt-2 text-[24px] leading-[30px]">{item.title}</h3>
                  <p className="mt-2 max-w-[520px] text-[15px] leading-[24px] text-fg-2">{item.body}</p>
                  <div className="mt-5 flex flex-col gap-3 rounded-md bg-surface-1 p-3.5 ring-1 ring-line-strong sm:flex-row sm:items-center sm:justify-between" aria-hidden>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-fg">{item.mock.line}</p>
                      <p className="truncate font-mono text-[11px] text-fg-muted">{item.mock.meta}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <span className="inline-flex h-7 items-center rounded-sm px-2.5 text-[12.5px] text-fg-2 ring-1 ring-inset ring-line-strong">{item.mock.secondary}</span>
                      <span className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-accent-wash px-2.5 text-[12.5px] font-medium text-accent-hi ring-1 ring-inset ring-accent-line">
                        <span className="size-[6px] rotate-45 bg-accent" />
                        {item.mock.primary}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ),
          )}
        </ol>
      </div>
    </Section>
  );
}
