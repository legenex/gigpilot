"use client";

import { Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover, Tooltip as RTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

const overlay =
  "fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out";

export function DialogContent({
  title,
  description,
  children,
  className,
  footer,
  size = "md",
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={overlay} />
      <RDialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,760px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface-1 shadow-3 ring-1 ring-inset ring-line-strong focus:outline-none",
          "data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out",
          size === "sm" && "max-w-md",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-2xl",
          className,
        )}
      >
        <div className="hairline-b flex items-start gap-4 px-5 pb-3.5 pt-4">
          <div className="min-w-0">
            <RDialog.Title className="font-display text-[16px] font-semibold tracking-[-0.01em] text-fg">{title}</RDialog.Title>
            {description ? <RDialog.Description className="mt-1 text-xs leading-5 text-fg-3">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RDialog.Description>}
          </div>
          <RDialog.Close className="-mr-1.5 ml-auto grid size-7 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </RDialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="hairline-t flex flex-wrap items-center justify-end gap-2 px-5 py-3">{footer}</div> : null}
      </RDialog.Content>
    </RDialog.Portal>
  );
}

// ---------------------------------------------------------------------------
// Sheet (side / bottom drawer on the same primitive)
// ---------------------------------------------------------------------------

export const Sheet = RDialog.Root;
export const SheetTrigger = RDialog.Trigger;
export const SheetClose = RDialog.Close;

export function SheetContent({
  side = "right",
  title,
  hideTitle,
  children,
  className,
}: {
  side?: "right" | "left" | "bottom";
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={overlay} />
      <RDialog.Content
        className={cn(
          "fixed z-50 flex flex-col bg-bg-raised shadow-3 focus:outline-none",
          side === "right" && "inset-y-0 right-0 w-[min(100vw,560px)] border-l border-line-strong data-[state=open]:animate-sheet-right-in data-[state=closed]:animate-sheet-right-out",
          side === "left" && "inset-y-0 left-0 w-[min(88vw,300px)] border-r border-line-strong data-[state=open]:animate-sheet-left-in data-[state=closed]:animate-sheet-left-out",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[88vh] rounded-t-lg border-t border-line-strong data-[state=open]:animate-sheet-bottom-in data-[state=closed]:animate-sheet-bottom-out",
          className,
        )}
      >
        <RDialog.Title className={hideTitle ? "sr-only" : "hairline-b px-4 py-3 text-[13px] font-semibold"}>{title}</RDialog.Title>
        <RDialog.Description className="sr-only">{title}</RDialog.Description>
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export const TooltipProvider = RTooltip.Provider;

export function Tooltip({ content, children, side = "top", delay }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; delay?: number }) {
  return (
    <RTooltip.Root delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-72 rounded-xs bg-surface-3 px-2 py-1.5 text-xs leading-4 text-fg shadow-2 ring-1 ring-inset ring-line-strong data-[state=delayed-open]:animate-pop-in"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({ children, align = "end", side = "bottom", className }: { children: ReactNode; align?: "start" | "end" | "center"; side?: "top" | "bottom" | "left" | "right"; className?: string }) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        className={cn(
          "z-[60] min-w-44 rounded-md bg-surface-2 p-1 shadow-3 ring-1 ring-inset ring-line-strong data-[state=open]:animate-pop-in",
          className,
        )}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
  danger,
  icon,
  shortcut,
  testId,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  disabled?: boolean;
  danger?: boolean;
  icon?: ReactNode;
  shortcut?: ReactNode;
  testId?: string;
}) {
  return (
    <RMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-[13px] text-fg-2 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-fg data-[disabled]:opacity-40",
        danger && "text-risk data-[highlighted]:text-risk",
      )}
    >
      {icon ? <span className="text-fg-3 [&_svg]:size-3.5">{icon}</span> : null}
      <span className="flex-1">{children}</span>
      {shortcut ? <span className="ml-4 text-fg-3">{shortcut}</span> : null}
    </RMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2 pb-1 pt-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">{children}</RMenu.Label>;
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-line" />;
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export const PopoverClose = RPopover.Close;

export function PopoverContent({ children, align = "start", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className={cn("z-[60] w-72 rounded-md bg-surface-2 p-3 shadow-3 ring-1 ring-inset ring-line-strong focus:outline-none data-[state=open]:animate-pop-in", className)}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
}
