import type { AnchorHTMLAttributes } from "react";
import { cn } from "@gigpilot/ui";

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-[#1a0a02] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(0,0,0,0.5)] hover:bg-accent-hi active:bg-accent-lo",
  outline: "text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-1 hover:ring-line-bright",
  ghost: "text-fg-2 hover:text-fg hover:bg-surface-1",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-sm",
  md: "h-10 px-4 text-[14px] gap-2 rounded-sm",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-md",
};

/**
 * Anchor-first button for the marketing site. Mirrors @gigpilot/ui Button
 * styling but adds a taller marketing size and renders a plain <a>, which
 * keeps auth links working without client JS.
 */
export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return (
    <a
      className={cn(
        "group/btn relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
