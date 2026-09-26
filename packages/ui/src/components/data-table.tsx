import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Dense data table primitives (32–36px rows, hairline separators, mono
 * right-aligned numbers). The wrapper scrolls horizontally inside its own
 * container so wide tables never scroll the page.
 */
export function DataTable({
  children,
  className,
  tableClassName,
  minWidth,
  label,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tableClassName?: string; minWidth?: number; label?: string }) {
  return (
    <div className={cn("relative w-full min-w-0 overflow-x-auto overscroll-x-contain", className)} {...props}>
      <table aria-label={label} className={cn("w-full border-separate border-spacing-0 text-[13px]", tableClassName)} style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className, sticky }: { children: ReactNode; className?: string; sticky?: boolean }) {
  return <thead className={cn(sticky && "sticky top-0 z-10 bg-bg", className)}>{children}</thead>;
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={className}>{children}</tbody>;
}

export function TR({
  children,
  className,
  interactive,
  selected,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      className={cn(
        "group/row [&>td]:shadow-[inset_0_-1px_0_0_var(--gp-line)]",
        interactive && "cursor-pointer hover:[&>td]:bg-surface-1 focus-visible:outline-none focus-visible:[&>td]:bg-surface-1",
        selected && "[&>td]:bg-surface-2 hover:[&>td]:bg-surface-2",
        className,
      )}
      aria-selected={selected || undefined}
      {...props}
    >
      {children}
    </tr>
  );
}

type Align = "left" | "right" | "center";

export function TH({
  children,
  className,
  align = "left",
  sticky,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: Align; sticky?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 whitespace-nowrap px-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-3 shadow-[inset_0_-1px_0_0_var(--gp-line-strong)]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        sticky && "sticky left-0 z-[1] bg-bg",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  align = "left",
  num,
  muted,
  sticky,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: Align; num?: boolean; muted?: boolean; sticky?: boolean }) {
  return (
    <td
      className={cn(
        "h-9 whitespace-nowrap px-3 align-middle transition-colors duration-150",
        num && "text-right font-mono text-xs tabular",
        !num && align === "right" && "text-right",
        align === "center" && "text-center",
        muted ? "text-fg-3" : "text-fg",
        sticky && "sticky left-0 z-[1] bg-bg",
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}
