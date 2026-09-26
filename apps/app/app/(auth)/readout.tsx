/** Illustrative pipeline trace on the auth screens (static, clearly labelled). */
const ROWS: { agent: string; text: string; meta: string; tone: "fg" | "profit" | "info" }[] = [
  { agent: "SCOUT", text: "Contra · 6 × 15s UGC ads for a skincare launch", meta: "normalised", tone: "fg" },
  { agent: "ANALYST", text: "6 deliverables · 1 missing input · 3-day deadline", meta: "conf 0.82", tone: "fg" },
  { agent: "ECONOMICS", text: "price $900 · cost $231 · profit $669", meta: "margin 74%", tone: "profit" },
  { agent: "GATES", text: "budget ✓  profit ✓  margin ✓  complete ✓", meta: "pursue", tone: "profit" },
  { agent: "PROPOSAL", text: "Draft ready — waiting for owner approval", meta: "you", tone: "info" },
];

export function AuthReadout() {
  return (
    <figure className="mt-10 rounded-md bg-bg/70 ring-1 ring-inset ring-line-strong">
      <figcaption className="hairline-b flex items-center justify-between px-4 py-2.5">
        <span className="eyebrow">Flight recorder · illustrative run</span>
        <span className="font-mono text-[11px] text-fg-3">T+00:02:16</span>
      </figcaption>
      <ol className="relative px-4 py-3">
        <span aria-hidden className="absolute bottom-5 left-[21px] top-5 w-px bg-line-strong" />
        {ROWS.map((r, i) => (
          <li key={r.agent} className="relative flex items-center gap-3 py-[7px] animate-fade-up" style={{ animationDelay: `${120 + i * 110}ms` }}>
            <span
              aria-hidden
              className={
                "relative z-[1] size-[9px] shrink-0 rounded-full ring-[3px] ring-bg " +
                (r.tone === "profit" ? "bg-profit" : r.tone === "info" ? "bg-info" : "bg-fg-3")
              }
            />
            <span className="w-[76px] shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-fg-3">{r.agent}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{r.text}</span>
            <span className="shrink-0 font-mono text-[11px] text-fg-3">{r.meta}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
