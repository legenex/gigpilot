import type { ReactNode } from "react";
import { cn } from "@gigpilot/ui";

/**
 * Page title block: H1 is the page name, the product line is an optional
 * muted tagline beside it, then one numerate line of context and
 * right-aligned actions. No box.
 */
export function PageHeader({
  eyebrow,
  title,
  tagline,
  description,
  actions,
  className,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Optional product line shown muted next to the page name (hidden on small screens). */
  tagline?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={cn("mb-5 flex flex-col gap-4 md:mb-6", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-display text-[22px] font-semibold leading-7 tracking-[-0.025em] text-fg md:text-[24px] md:leading-8">{title}</h1>
            {tagline ? <p className="hidden text-[13px] text-fg-3 md:block">{tagline}</p> : null}
          </div>
          {description ? <p className="mt-1 max-w-3xl text-[13px] leading-5 text-fg-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
