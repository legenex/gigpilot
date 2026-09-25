import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "link";
type Size = "xs" | "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-[#1a0a02] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.4)] hover:bg-accent-hi active:bg-accent-lo",
  secondary: "bg-surface-2 text-fg shadow-1 hover:bg-surface-3 active:bg-surface-2",
  outline: "bg-transparent text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-1 hover:ring-line-bright",
  ghost: "bg-transparent text-fg-2 hover:text-fg hover:bg-surface-1",
  danger: "bg-risk-wash text-risk ring-1 ring-inset ring-risk/30 hover:bg-risk/20",
  link: "bg-transparent text-fg underline-offset-4 hover:underline px-0 h-auto",
};

const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded-xs",
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-sm",
  md: "h-8 px-3 text-[13px] gap-2 rounded-sm",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", asChild, loading, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      className={cn(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-45 active:translate-y-px",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="absolute inset-0 grid place-items-center">
            <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          </span>
          <span className="invisible inline-flex items-center gap-[inherit]">{children}</span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
});
