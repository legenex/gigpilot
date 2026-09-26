"use client";

import { useRouter } from "next/navigation";
import type { HTMLAttributes, ReactNode } from "react";
import { TR } from "@gigpilot/ui";

/** Table row that navigates on click (keyboard users use the row's primary link). */
export function ClickableRow({ href, children, ...rest }: { href: string; children: ReactNode } & HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string>) {
  const router = useRouter();
  return (
    <TR
      interactive
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,input,select,textarea,[role=menuitem]")) return;
        if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
        else router.push(href);
      }}
      {...rest}
    >
      {children}
    </TR>
  );
}
