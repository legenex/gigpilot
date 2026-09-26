"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { Kbd, LogoMark, Sheet, SheetContent, ToastProvider, Tooltip, TooltipProvider, cn } from "@gigpilot/ui";
import { LiveProvider } from "@/components/live/live-provider";
import type { NavCounts } from "@/lib/queries/shell";
import { CommandMenu } from "./command-menu";
import { LiveIndicator } from "./live-indicator";
import { NAV, NAV_GROUPS, isActive } from "./nav";
import { PasteOpportunityDialog, type ManualSourceKey } from "./paste-dialog";
import { UserMenu } from "./user-menu";

interface ShellApi {
  openPalette: () => void;
  openPaste: (source?: ManualSourceKey) => void;
}
const ShellCtx = createContext<ShellApi>({ openPalette: () => {}, openPaste: () => {} });
export const useShell = () => useContext(ShellCtx);

export interface ShellUser {
  name: string;
  email: string;
}

export function AppShell({
  children,
  user,
  tenantName,
  tenantMode,
  counts,
  initialSeq,
  initialCollapsed,
}: {
  children: ReactNode;
  user: ShellUser;
  tenantName: string;
  tenantMode: "demo" | "live";
  counts: NavCounts;
  initialSeq: number;
  initialCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paste, setPaste] = useState<{ open: boolean; source?: ManualSourceKey }>({ open: false });
  const router = useRouter();
  const pathname = usePathname();

  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `gp_rail=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  const api = useMemo<ShellApi>(() => ({ openPalette: () => setPaletteOpen(true), openPaste: (source) => setPaste({ open: true, source }) }), []);

  // Close the mobile sheet on navigation.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      setMobileOpen(false);
    }
  }, [pathname]);

  // Global shortcuts: ⌘K palette, [ rail, "g then key" navigation.
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") {
        toggleRail();
        return;
      }
      if (e.key === "g") {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt < 900) {
        const item = NAV.find((n) => n.key === e.key.toLowerCase());
        if (item) {
          e.preventDefault();
          router.push(item.href);
        }
        gAt = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, toggleRail]);

  return (
    <ShellCtx.Provider value={api}>
      <TooltipProvider delayDuration={350}>
        <ToastProvider>
          <LiveProvider initialSeq={initialSeq}>
            <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:rounded-sm focus:bg-surface-3 focus:px-3 focus:py-2 focus:text-[13px]">
              Skip to content
            </a>
            <div className="flex min-h-dvh">
              <aside
                className={cn(
                  "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-bg-raised transition-[width] duration-200 ease-out md:flex",
                  collapsed ? "w-[56px]" : "w-[228px]",
                )}
                aria-label="Primary"
              >
                <RailContent
                  collapsed={collapsed}
                  onToggle={toggleRail}
                  onSearch={() => setPaletteOpen(true)}
                  pathname={pathname}
                  counts={counts}
                  tenantName={tenantName}
                  tenantMode={tenantMode}
                  user={user}
                />
              </aside>

              <div className="flex min-w-0 flex-1 flex-col">
                {/* Mobile top bar */}
                <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg-raised/95 px-3 backdrop-blur md:hidden">
                  <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                    <button
                      type="button"
                      onClick={() => setMobileOpen(true)}
                      className="grid size-9 place-items-center rounded-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
                      aria-label="Open navigation"
                    >
                      <MenuIcon className="size-[18px]" strokeWidth={1.75} />
                    </button>
                    <SheetContent side="left" title="Navigation" hideTitle className="w-[min(86vw,300px)]">
                      <RailContent
                        collapsed={false}
                        mobile
                        onSearch={() => {
                          setMobileOpen(false);
                          setPaletteOpen(true);
                        }}
                        pathname={pathname}
                        counts={counts}
                        tenantName={tenantName}
                        tenantMode={tenantMode}
                        user={user}
                      />
                    </SheetContent>
                  </Sheet>
                  <Link href="/" className="flex items-center gap-2" aria-label="GigPilot home">
                    <LogoMark className="size-5" />
                    <span className="font-display text-[15px] font-semibold tracking-[-0.02em]">GigPilot</span>
                  </Link>
                  <div className="ml-auto flex items-center gap-1">
                    <LiveIndicator compact runningAgents={counts.runningAgents} />
                    <button
                      type="button"
                      onClick={() => setPaletteOpen(true)}
                      className="grid size-9 place-items-center rounded-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
                      aria-label="Search and commands"
                    >
                      <Search className="size-[18px]" strokeWidth={1.75} />
                    </button>
                  </div>
                </header>

                <main id="main" className="min-w-0 flex-1 outline-none" tabIndex={-1}>
                  {children}
                </main>
              </div>
            </div>
            <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} onPaste={() => setPaste({ open: true })} onToggleRail={toggleRail} />
            <PasteOpportunityDialog open={paste.open} source={paste.source} onOpenChange={(open) => setPaste((p) => ({ ...p, open }))} />
          </LiveProvider>
        </ToastProvider>
      </TooltipProvider>
    </ShellCtx.Provider>
  );
}

function RailContent({
  collapsed,
  mobile,
  onToggle,
  onSearch,
  pathname,
  counts,
  tenantName,
  tenantMode,
  user,
}: {
  collapsed: boolean;
  mobile?: boolean;
  onToggle?: () => void;
  onSearch: () => void;
  pathname: string;
  counts: NavCounts;
  tenantName: string;
  tenantMode: "demo" | "live";
  user: ShellUser;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex h-12 shrink-0 items-center gap-2", collapsed ? "justify-center px-0" : "px-3.5")}>
        <Link href="/" className="flex min-w-0 items-center gap-2 rounded-sm" aria-label="GigPilot — Command Center">
          <LogoMark className="size-[22px]" />
          {!collapsed ? <span className="font-display text-[16px] font-semibold tracking-[-0.02em]">GigPilot</span> : null}
        </Link>
        {!collapsed && !mobile ? (
          <Tooltip content={<span className="flex items-center gap-2">Collapse sidebar <Kbd>[</Kbd></span>} side="right">
            <button type="button" onClick={onToggle} className="ml-auto grid size-7 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Collapse sidebar">
              <PanelLeftClose className="size-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="px-3.5 pb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium text-fg-2" title={tenantName}>
              {tenantName}
            </span>
            <span
              className={cn("shrink-0 rounded-[3px] px-1.5 font-mono text-[11px] font-medium uppercase leading-[18px] tracking-[0.06em] ring-1 ring-inset", tenantMode === "demo" ? "text-info ring-info/30" : "text-profit ring-profit/30")}
              title={tenantMode === "demo" ? "Demo mode — sources are the demo marketplace; no real submissions or spend" : "Live mode — configured integrations"}
            >
              {tenantMode === "demo" ? "Demo mode" : "Live"}
            </span>
          </div>
        </div>
      ) : null}

      <div className={cn("pb-2", collapsed ? "px-2" : "px-2.5")}>
        {collapsed ? (
          <Tooltip content={<span className="flex items-center gap-2">Search <Kbd>⌘K</Kbd></span>} side="right">
            <button type="button" onClick={onSearch} className="grid h-8 w-full place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Search and commands">
              <Search className="size-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={onSearch}
            className="flex h-8 w-full items-center gap-2 rounded-sm bg-surface-1 px-2.5 text-[13px] text-fg-3 ring-1 ring-inset ring-line transition-colors hover:text-fg-2 hover:ring-line-strong"
          >
            <Search className="size-3.5" strokeWidth={1.75} />
            <span className="flex-1 text-left">Search or jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>
        )}
      </div>

      <nav className={cn("min-h-0 flex-1 overflow-y-auto pb-3", collapsed ? "px-2" : "px-2.5")} aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <div key={group} className="mt-3 first:mt-1">
            {!collapsed ? <p className="px-2 pb-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">{group}</p> : <div className="mx-2 mb-2 h-px bg-line" />}
            <ul className="flex flex-col gap-px">
              {NAV.filter((n) => n.group === group).map((item) => {
                const active = isActive(pathname, item.href);
                const count = item.count ? counts[item.count] : 0;
                const Icon = item.icon;
                const link = (
                  <Link
                    href={item.href}
                    data-testid={item.testId}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex h-8 items-center gap-2.5 rounded-sm text-[13px] transition-colors duration-150 focus-inset",
                      collapsed ? "justify-center" : "px-2",
                      active ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface-1 hover:text-fg",
                    )}
                  >
                    {active ? <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[2px] rounded-r-full bg-fg" aria-hidden /> : null}
                    <Icon className={cn("size-4 shrink-0", active ? "text-fg" : "text-fg-3 group-hover:text-fg-2")} strokeWidth={1.75} />
                    {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
                    {!collapsed && count > 0 ? (
                      <span className="min-w-5 rounded-[4px] bg-surface-3 px-1 text-center font-mono text-[11px] leading-[18px] tabular text-fg-2">{count}</span>
                    ) : null}
                    {collapsed && count > 0 ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-fg-2" aria-label={`${count} pending`} /> : null}
                  </Link>
                );
                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip content={<span className="flex items-center gap-2">{item.label}{count > 0 ? <span className="font-mono text-fg-3">{count}</span> : null}<Kbd>G</Kbd><Kbd>{item.key.toUpperCase()}</Kbd></span>} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn("shrink-0 border-t border-line py-2", collapsed ? "px-2" : "px-2.5")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <LiveIndicator compact runningAgents={counts.runningAgents} />
            <Tooltip content={<span className="flex items-center gap-2">Expand sidebar <Kbd>[</Kbd></span>} side="right">
              <button type="button" onClick={onToggle} className="grid size-8 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Expand sidebar">
                <PanelLeftOpen className="size-4" strokeWidth={1.75} />
              </button>
            </Tooltip>
            <UserMenu user={user} compact />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="px-2 py-1">
              <LiveIndicator runningAgents={counts.runningAgents} />
            </div>
            <UserMenu user={user} />
          </div>
        )}
      </div>
    </div>
  );
}
