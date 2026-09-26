import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Section header: mono eyebrow + 13px title + optional meta/actions.
 * Groups content with a hairline instead of a box (DESIGN rule 1).
 */
export function SectionHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
  id,
  hairline = true,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
  hairline?: boolean;
}) {
  return (
    <div className={cn("flex min-h-9 items-center gap-3 pb-2", hairline && "hairline-b mb-3", className)}>
      <div className="flex min-w-0 items-baseline gap-2.5">
        {eyebrow ? <span className="eyebrow shrink-0">{eyebrow}</span> : null}
        <h2 id={id} className="shrink-0 text-[13px] font-semibold text-fg">
          {title}
        </h2>
        {meta ? <span className="min-w-0 truncate text-xs text-fg-3">{meta}</span> : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** "plain" = hairline section (default). "surface" = raised box, for interactive/elevated content. */
  variant?: "plain" | "surface";
  bodyClassName?: string;
  as?: "section" | "div" | "aside";
}

export function Panel({
  title,
  eyebrow,
  meta,
  actions,
  variant = "plain",
  className,
  bodyClassName,
  children,
  as: Comp = "section",
  ...props
}: PanelProps) {
  return (
    <Comp
      className={cn(
        "min-w-0",
        variant === "surface" && "rounded-md bg-surface-1 p-4 ring-1 ring-inset ring-line",
        className,
      )}
      {...props}
    >
      {title ? <SectionHeader eyebrow={eyebrow} title={title} meta={meta} actions={actions} /> : null}
      <div className={cn("min-w-0", bodyClassName)}>{children}</div>
    </Comp>
  );
}

/** Label/value definition list with hairline rows — for detail panes. */
export function KeyValue({
  items,
  className,
  dense,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean; hint?: ReactNode }[];
  className?: string;
  dense?: boolean;
}) {
  return (
    <dl className={cn("divide-y divide-line", className)}>
      {items.map((it, i) => (
        <div key={i} className={cn("flex items-baseline justify-between gap-4", dense ? "py-1.5" : "py-2")}>
          <dt className="shrink-0 text-xs text-fg-3">{it.label}</dt>
          <dd className={cn("min-w-0 text-right text-[13px] text-fg", it.mono && "font-mono text-xs tabular")}>
            {it.value}
            {it.hint ? <span className="ml-1.5 text-fg-3">{it.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
