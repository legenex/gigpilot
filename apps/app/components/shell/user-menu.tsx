"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Cable, Keyboard, LogOut, Settings2 } from "lucide-react";
import { authClient } from "@gigpilot/auth/client";
import { Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, cn } from "@gigpilot/ui";
import type { ShellUser } from "./app-shell";

function initials(name: string, email: string): string {
  const src = name.trim() || email;
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function UserMenu({ user, compact }: { user: ShellUser; compact?: boolean }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const logout = async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };
  return (
    <Menu>
      <MenuTrigger
        data-testid="user-menu"
        className={cn(
          "flex items-center gap-2.5 rounded-sm text-left outline-none transition-colors hover:bg-surface-1 focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-surface-2",
          compact ? "size-8 justify-center" : "h-10 w-full px-2",
        )}
        aria-label="Account menu"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 font-mono text-[10px] font-semibold text-fg-2 ring-1 ring-inset ring-line-strong">
          {initials(user.name, user.email)}
        </span>
        {!compact ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-4 text-fg">{user.name || "Owner"}</span>
            <span className="block truncate text-[11px] leading-4 text-fg-3">{user.email}</span>
          </span>
        ) : null}
      </MenuTrigger>
      <MenuContent align={compact ? "start" : "end"} side={compact ? "right" : "top"} className="w-56">
        <MenuLabel>{user.email}</MenuLabel>
        <MenuItem icon={<Settings2 />} onSelect={() => router.push("/settings")} shortcut={<><Kbd>G</Kbd> <Kbd>S</Kbd></>}>
          Settings
        </MenuItem>
        <MenuItem icon={<Cable />} onSelect={() => router.push("/integrations")} shortcut={<><Kbd>G</Kbd> <Kbd>I</Kbd></>}>
          Integrations
        </MenuItem>
        <MenuItem icon={<Keyboard />} onSelect={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))} shortcut={<Kbd>⌘K</Kbd>}>
          Command palette
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut />} onSelect={logout} disabled={signingOut} testId="logout">
          {signingOut ? "Signing out…" : "Log out"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
