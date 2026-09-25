import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type Tone = "neutral" | "accent" | "profit" | "warn" | "risk" | "info" | "violet";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2 ring-line-strong",
  accent: "bg-accent-wash text-accent-hi ring-accent-line",
  profit: "bg-profit-wash text-profit ring-profit/25",
  warn: "bg-warn-wash text-warn ring-warn/25",
  risk: "bg-risk-wash text-risk ring-risk/25",
  info: "bg-info-wash text-info ring-info/25",
  violet: "bg-violet/10 text-violet ring-violet/25",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  mono?: boolean;
}

export function Badge({ tone = "neutral", mono, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-[11px] font-medium leading-none ring-1 ring-inset",
        mono && "font-mono uppercase tracking-[0.04em]",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
