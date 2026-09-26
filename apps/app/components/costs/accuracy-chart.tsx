import Link from "next/link";
import { cn, formatUsd } from "@gigpilot/ui";

/**
 * Estimate vs actual per job as a dot plot on one shared axis: the band is
 * the ±accuracy target around the estimate, the ring is the estimate, the
 * filled dot the actual. Values are labelled in text, never colour alone.
 */
export function AccuracyChart({ rows, targetPct }: { rows: { id: string; title: string; est: number; act: number; done: boolean }[]; targetPct: number }) {
  const data = rows.filter((r) => r.est > 0);
  if (!data.length) return <p className="py-4 text-xs text-fg-3">Accuracy appears once jobs record actual costs.</p>;
  const max = Math.max(...data.map((r) => Math.max(r.est * (1 + targetPct / 100), r.act))) * 1.08;
  const x = (v: number) => `${(v / max) * 100}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <figure>
      <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_92px] items-center gap-x-4">
        <span />
        <div className="relative h-4">
          {ticks.map((t, i) => (
            <span key={i} className="absolute -translate-x-1/2 font-mono text-[10px] text-fg-3" style={{ left: x(t) }}>
              {formatUsd(t)}
            </span>
          ))}
        </div>
        <span className="text-right font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3">act · Δ</span>
      </div>
      <ul className="mt-1">
        {data.map((r) => {
          const delta = r.act / r.est - 1;
          const within = Math.abs(delta) <= targetPct / 100;
          return (
            <li key={r.id} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_92px] items-center gap-x-4 border-t border-line py-2">
              <Link href={`/jobs/${r.id}`} className="truncate text-xs text-fg-2 hover:text-fg" title={r.title}>
                {r.title}
              </Link>
              <div className="relative h-5" role="img" aria-label={`${r.title}: estimate ${formatUsd(r.est, { cents: true })}, actual ${formatUsd(r.act, { cents: true })}`}>
                {ticks.map((t, i) => (
                  <span key={i} className="absolute inset-y-0 w-px bg-line" style={{ left: x(t) }} aria-hidden />
                ))}
                <span className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px] bg-white/[0.07]" style={{ left: x(r.est * (1 - targetPct / 100)), width: `calc(${x(r.est * (1 + targetPct / 100))} - ${x(r.est * (1 - targetPct / 100))})` }} aria-hidden />
                <span className="absolute top-1/2 h-px -translate-y-1/2 bg-fg-3" style={{ left: x(Math.min(r.est, r.act)), width: `calc(${x(Math.max(r.est, r.act))} - ${x(Math.min(r.est, r.act))})` }} aria-hidden />
                <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[1.5px] ring-fg-2" style={{ left: x(r.est) }} aria-hidden />
                <span className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg", within ? "bg-series-1" : "bg-warn")} style={{ left: x(r.act) }} aria-hidden />
              </div>
              <span className="text-right font-mono text-[11px] tabular">
                <span className="text-fg">{formatUsd(r.act, { cents: true })}</span>{" "}
                <span className={within ? "text-fg-3" : "text-warn"}>
                  {delta >= 0 ? "+" : "−"}
                  {Math.abs(Math.round(delta * 100))}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-3">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full ring-[1.5px] ring-fg-2" aria-hidden /> estimate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-series-1" aria-hidden /> actual (within target)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-warn" aria-hidden /> actual (outside ±{targetPct}%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px] bg-white/[0.07]" aria-hidden /> ±{targetPct}% target band
        </span>
      </figcaption>
    </figure>
  );
}
