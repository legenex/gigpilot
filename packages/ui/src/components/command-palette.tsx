"use client";

import { Command } from "cmdk";
import { Dialog as RDialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface CommandItemDef {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  shortcut?: ReactNode;
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandGroupDef {
  heading: string;
  items: CommandItemDef[];
}

/**
 * ⌘K palette on cmdk + Radix Dialog. Groups are provided by the app;
 * `onQueryChange` lets the app append async results (e.g. opportunities).
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  query,
  onQueryChange,
  loading,
  placeholder = "Type a command or search…",
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: CommandGroupDef[];
  query: string;
  onQueryChange: (q: string) => void;
  loading?: boolean;
  placeholder?: string;
  footer?: ReactNode;
}) {
  // Keep the highlight on the first visible result whenever the query or the
  // (possibly async) result set changes, so ↵ always opens the top match.
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("");
  const signature = groups.map((g) => `${g.heading}:${g.items.map((i) => i.id).join(",")}`).join("|");
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const first = listRef.current?.querySelector<HTMLElement>("[cmdk-item]:not([aria-disabled='true'])");
      const v = first?.getAttribute("data-value");
      if (v) setSelected(v);
    });
    return () => window.cancelAnimationFrame(id);
  }, [query, signature, open]);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <RDialog.Content
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-24px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-lg bg-surface-1 shadow-3 ring-1 ring-inset ring-line-strong focus:outline-none data-[state=open]:animate-pop-in"
          aria-describedby={undefined}
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command label="Command palette" loop className="flex flex-col" shouldFilter value={selected} onValueChange={setSelected}>
            <div className="hairline-b flex items-center gap-2.5 px-4">
              <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-fg-3" aria-hidden>
                <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder={placeholder}
                className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-3"
              />
              {loading ? <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-fg-3 border-t-transparent" aria-label="Searching" /> : null}
            </div>
            <Command.List ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-fg-3">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-fg-3">{loading ? "Searching…" : "No matches."}</Command.Empty>
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <Command.Group key={g.heading} heading={g.heading}>
                    {g.items.map((it) => (
                      <Command.Item
                        key={it.id}
                        value={`${it.id} ${it.label}`}
                        keywords={it.keywords}
                        onSelect={() => {
                          it.onSelect();
                        }}
                        className={cn(
                          "flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-fg-2",
                          "data-[selected=true]:bg-surface-3 data-[selected=true]:text-fg",
                        )}
                      >
                        {it.icon ? <span className="grid size-4 place-items-center text-fg-3 [&_svg]:size-4">{it.icon}</span> : null}
                        <span className="min-w-0 flex-1 truncate">{it.label}</span>
                        {it.hint ? <span className="max-w-[40%] truncate font-mono text-[11px] text-fg-3">{it.hint}</span> : null}
                        {it.shortcut}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
            </Command.List>
            {footer ? <div className="hairline-t flex items-center gap-3 px-3.5 py-2 text-[11px] text-fg-3">{footer}</div> : null}
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
