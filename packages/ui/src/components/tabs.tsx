"use client";

import Link from "next/link";
import { Tabs as RTabs } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export const Tabs = RTabs.Root;
export const TabsContent = RTabs.Content;

/** Underline tabs (hairline rail, active item gets a 2px fg underline). */
export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <RTabs.List aria-label={label} className={cn("hairline-b flex gap-4 overflow-x-auto", className)}>
      {children}
    </RTabs.List>
  );
}

export function TabsTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <RTabs.Trigger
      value={value}
      className="relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] text-fg-3 outline-none transition-colors hover:text-fg-2 focus-visible:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-[2px] data-[state=active]:after:rounded-full data-[state=active]:after:bg-fg"
    >
      {children}
      {count !== undefined ? <span className="font-mono text-[11px] tabular text-fg-3">{count}</span> : null}
    </RTabs.Trigger>
  );
}

export interface SegmentItem {
  value: string;
  label: ReactNode;
  count?: number | null;
  href?: string;
  testId?: string;
  icon?: ReactNode;
}

/** Compact segmented control; items can be links (URL state) or buttons. */
export function SegmentedControl({
  items,
  value,
  onValueChange,
  className,
  label,
  size = "md",
}: {
  items: SegmentItem[];
  value: string;
  onValueChange?: (v: string) => void;
  className?: string;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-sm bg-surface-1 p-0.5 ring-1 ring-inset ring-line", className)}>
      {items.map((it) => {
        const active = it.value === value;
        const cls = cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent",
          size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-[13px]",
          active ? "bg-surface-3 text-fg shadow-1" : "text-fg-3 hover:text-fg-2",
        );
        const inner = (
          <>
            {it.icon}
            {it.label}
            {it.count !== undefined && it.count !== null ? <span className={cn("font-mono text-[11px] tabular", active ? "text-fg-2" : "text-fg-3")}>{it.count}</span> : null}
          </>
        );
        return it.href ? (
          <Link key={it.value} href={it.href} role="tab" aria-selected={active} className={cls} data-testid={it.testId} scroll={false}>
            {inner}
          </Link>
        ) : (
          <button key={it.value} type="button" role="tab" aria-selected={active} className={cls} data-testid={it.testId} onClick={() => onValueChange?.(it.value)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}
