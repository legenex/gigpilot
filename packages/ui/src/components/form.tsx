"use client";

import { Slider as RSlider, Switch as RSwitch } from "radix-ui";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

const control =
  "w-full rounded-xs bg-surface-1 text-[13px] text-fg placeholder:text-fg-3 ring-1 ring-inset ring-line-strong transition-[box-shadow,background-color] duration-150 hover:ring-line-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:ring-risk/70";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Adornment rendered inside the left edge (e.g. "$"). */
  prefix?: string;
  /** Adornment rendered inside the right edge (e.g. "%"). */
  suffix?: string;
  inputSize?: "sm" | "md";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, prefix, suffix, inputSize = "md", ...props }, ref) {
  const h = inputSize === "sm" ? "h-7" : "h-8";
  if (!prefix && !suffix) return <input ref={ref} className={cn(control, h, "px-2.5", className)} {...props} />;
  return (
    <div className={cn("relative flex items-center", className)}>
      {prefix ? <span className="pointer-events-none absolute left-2.5 font-mono text-xs text-fg-3">{prefix}</span> : null}
      <input ref={ref} className={cn(control, h, prefix ? "pl-6" : "pl-2.5", suffix ? "pr-8" : "pr-2.5", props.type === "number" && "font-mono text-xs tabular")} {...props} />
      {suffix ? <span className="pointer-events-none absolute right-2.5 font-mono text-xs text-fg-3">{suffix}</span> : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 px-2.5 py-2 leading-5", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { selectSize?: "sm" | "md" }>(function Select(
  { className, children, selectSize = "md", ...props },
  ref,
) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className={cn(control, selectSize === "sm" ? "h-7" : "h-8", "cursor-pointer appearance-none pl-2.5 pr-7")}
        {...props}
      >
        {children}
      </select>
      <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 size-2.5 -translate-y-1/2 text-fg-3">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export function Label({ htmlFor, children, className }: { htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("text-xs font-medium text-fg-2", className)}>
      {children}
    </label>
  );
}

/** Label + control + hint + inline error, wired with aria-describedby. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-risk" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs leading-5 text-fg-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  size = "md",
  testId,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  id?: string;
  size?: "sm" | "md";
  testId?: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full bg-surface-3 ring-1 ring-inset ring-line-strong transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-profit/85 data-[state=checked]:ring-profit/40",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
      )}
    >
      <RSwitch.Thumb
        className={cn(
          "block rounded-full bg-fg shadow-1 transition-transform duration-200 ease-out",
          size === "sm" ? "size-3 translate-x-0.5 data-[state=checked]:translate-x-[13px]" : "size-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]",
        )}
      />
    </RSwitch.Root>
  );
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  label,
  marker,
  className,
}: {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label: string;
  /** Optional reference marker on the track (e.g. recommended value). */
  marker?: number | null;
  className?: string;
}) {
  return (
    <RSlider.Root
      value={[value]}
      onValueChange={(v) => onValueChange(v[0] ?? 0)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      className={cn("relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40", className)}
    >
      <RSlider.Track className="relative h-1 grow overflow-visible rounded-full bg-surface-3">
        <RSlider.Range className="absolute h-full rounded-full bg-fg-2" />
        {marker !== null && marker !== undefined ? (
          <span
            aria-hidden
            className="absolute top-1/2 h-2.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-info"
            style={{ left: `${((marker - min) / (max - min)) * 100}%` }}
          />
        ) : null}
      </RSlider.Track>
      <RSlider.Thumb className="block size-3.5 cursor-grab rounded-full bg-fg shadow-1 ring-4 ring-transparent transition-shadow hover:ring-white/10 focus-visible:outline-none focus-visible:ring-accent/40 active:cursor-grabbing" />
    </RSlider.Root>
  );
}
