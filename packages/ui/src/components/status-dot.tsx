import { cn } from "../lib/cn";
import type { Tone } from "./badge";

const colors: Record<Tone, string> = {
  neutral: "text-fg-3 bg-fg-3",
  accent: "text-accent bg-accent",
  profit: "text-profit bg-profit",
  warn: "text-warn bg-warn",
  risk: "text-risk bg-risk",
  info: "text-info bg-info",
  violet: "text-violet bg-violet",
};

/** Small status indicator. `live` pulses — use only when work is actually running. */
export function StatusDot({ tone = "neutral", live, className, label }: { tone?: Tone; live?: boolean; className?: string; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", colors[tone], live && "animate-pulse-dot", className)}
    />
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] bg-surface-2 px-1 font-mono text-[10.5px] font-medium text-fg-3 ring-1 ring-inset ring-line-strong",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
