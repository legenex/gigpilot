import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";
import { Button, cn, formatUsd } from "@gigpilot/ui";
import { RelTime } from "@/components/rel-time";
import type { NeedsYouItem } from "@/lib/queries/command-center";

const KIND: Record<NeedsYouItem["kind"], { label: string; cta: string; amountLabel: string }> = {
  delivery: { label: "Delivery", cta: "Review delivery", amountLabel: "contract" },
  proposal: { label: "Proposal", cta: "Review proposal", amountLabel: "price" },
  submit: { label: "Submit", cta: "Open applications", amountLabel: "price" },
  pursue: { label: "Pursue?", cta: "Decide", amountLabel: "exp. profit" },
  inputs: { label: "Inputs", cta: "Confirm inputs", amountLabel: "contract" },
  blocked: { label: "Blocked", cta: "Unblock job", amountLabel: "contract" },
};

/**
 * The owner's decision queue — the single accent moment on the Command
 * Center. Commitments (delivery, proposal) sort above suggestions.
 */
export function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  const commitments = items.filter((i) => i.kind !== "pursue").length;
  return (
    <section
      aria-labelledby="needs-you-title"
      className="relative overflow-hidden rounded-md bg-[linear-gradient(90deg,rgba(255,107,44,0.075),rgba(255,107,44,0.015)_38%,transparent_70%)] ring-1 ring-inset ring-line"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
      <div className="flex items-center gap-3 px-4 pb-2 pt-3 sm:px-5">
        <h2 id="needs-you-title" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[13px] font-semibold text-fg">
          Needs you
          <span className="rounded-[4px] bg-accent px-1.5 font-mono text-[11px] font-semibold leading-[18px] text-[#1a0a02] tabular">{items.length}</span>
        </h2>
        <p className="truncate text-xs text-fg-3">
          {items.length === 0
            ? "Nothing is waiting on you."
            : `${commitments} commitment${commitments === 1 ? "" : "s"} · ${items.length - commitments} suggestion${items.length - commitments === 1 ? "" : "s"} — agents keep working while you decide`}
        </p>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-1 text-[13px] text-fg-2 sm:px-5">
          <CircleCheck className="size-4 text-profit" strokeWidth={1.75} />
          All clear. Agents are sourcing and producing — you’ll get a notification when a decision is due.
        </div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {items.slice(0, 6).map((it, i) => {
            const k = KIND[it.kind];
            return (
              <li key={`${it.kind}-${it.id}`} className="group relative flex items-center gap-x-4 px-4 py-2.5 hover:bg-white/[0.015] sm:px-5">
                <span className={cn("hidden w-16 shrink-0 font-mono text-[10.5px] uppercase tracking-[0.06em] sm:block", it.kind === "pursue" ? "text-fg-3" : "text-accent-hi")}>{k.label}</span>
                <div className="min-w-0 flex-1">
                  <span className={cn("mb-0.5 block font-mono text-[10px] uppercase tracking-[0.06em] sm:hidden", it.kind === "pursue" ? "text-fg-3" : "text-accent-hi")}>{k.label}</span>
                  <Link href={it.href} className="block truncate text-[13px] font-medium text-fg outline-none after:absolute after:inset-0 hover:underline focus-visible:underline">
                    {it.title}
                  </Link>
                  <p className="truncate text-xs text-fg-3">{it.detail}</p>
                </div>
                <div className="hidden w-28 shrink-0 text-right sm:block">
                  <p className="font-mono text-[13px] tabular text-fg">{formatUsd(it.amountUsd)}</p>
                  <p className="text-[11px] text-fg-3">{k.amountLabel}</p>
                </div>
                <RelTime date={it.at} className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-fg-3 md:block" />
                <span className="shrink-0 text-right font-mono text-xs tabular text-fg sm:hidden">{formatUsd(it.amountUsd)}</span>
                <ArrowRight className="size-4 shrink-0 text-fg-3 sm:hidden" strokeWidth={1.75} aria-hidden />
                <Button asChild size="sm" variant={i === 0 && it.kind !== "pursue" ? "primary" : "outline"} className="relative z-[1] hidden shrink-0 sm:inline-flex">
                  <Link href={it.href}>
                    {k.cta}
                    <ArrowRight className="size-3.5" strokeWidth={1.75} />
                  </Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
