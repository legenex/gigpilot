import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Shimmering placeholder. Respects reduced motion via the theme's global rule. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} style={style} />;
}

/** Empty state that tells the owner what to do next. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 rounded-md border border-dashed border-line-strong",
        compact ? "px-4 py-4" : "px-5 py-7",
        className,
      )}
    >
      {icon ? <div className="mb-1 text-fg-3 [&_svg]:size-4">{icon}</div> : null}
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {description ? <p className="max-w-prose text-xs leading-5 text-fg-3">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

/** Inline notice / callout. */
export function Callout({
  tone = "neutral",
  icon,
  title,
  children,
  className,
}: {
  tone?: "neutral" | "warn" | "risk" | "info" | "profit" | "accent";
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "border-line-strong text-fg-2",
    warn: "border-warn/35 text-fg-2 [--c:var(--gp-warn)]",
    risk: "border-risk/35 text-fg-2 [--c:var(--gp-risk)]",
    info: "border-info/35 text-fg-2 [--c:var(--gp-info)]",
    profit: "border-profit/35 text-fg-2 [--c:var(--gp-profit)]",
    accent: "border-accent-line text-fg-2 [--c:var(--gp-accent)]",
  } as const;
  return (
    <div className={cn("flex gap-2.5 border-l-2 py-1 pl-3 text-xs leading-5", tones[tone], className)} role={tone === "risk" ? "alert" : undefined}>
      {icon ? <span className="mt-0.5 shrink-0 text-[var(--c,var(--gp-fg-3))] [&_svg]:size-3.5">{icon}</span> : null}
      <div className="min-w-0">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
