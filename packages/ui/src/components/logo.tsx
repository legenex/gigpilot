import { cn } from "../lib/cn";

/**
 * GigPilot mark: a heading-indicator ring with a course chevron cutting
 * through it. Monochrome by default; `accent` colours the chevron.
 */
export function LogoMark({ className, accent = true, title = "GigPilot" }: { className?: string; accent?: boolean; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label={title} className={cn("size-6 shrink-0", className)} fill="none">
      <circle cx="16" cy="16" r="12.25" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.75" />
      <path d="M16 3.75v3.1M16 25.15v3.1M3.75 16h3.1M25.15 16h3.1" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M10.2 21.8 21.4 10.6m0 0h-7.3m7.3 0v7.3"
        stroke={accent ? "var(--gp-accent)" : "currentColor"}
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-fg", className)}>
      <LogoMark className={markClassName} />
      <span className="font-display text-[17px] font-semibold tracking-[-0.02em]">GigPilot</span>
    </span>
  );
}
