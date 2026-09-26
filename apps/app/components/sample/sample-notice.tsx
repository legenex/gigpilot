"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ClearSampleButton } from "./clear-sample-button";

/**
 * Dismissible Command Center notice while seeded sample history exists.
 * Dismissal is a per-browser convenience; the Settings control stays.
 */
export function SampleNotice({ tenantId }: { tenantId: string }) {
  const key = `gp:sample-notice:${tenantId}`;
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(key) === "1";
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read per-browser preference after hydration
    setHidden(dismissed);
  }, [key]);
  if (hidden) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      /* storage unavailable */
    }
    setHidden(true);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md px-4 py-2.5 ring-1 ring-inset ring-line" role="note" data-testid="sample-notice">
      <span className="inline-flex h-[18px] items-center rounded-xs px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3 ring-1 ring-inset ring-line-strong">Sample</span>
      <p className="min-w-0 basis-full text-xs leading-5 text-fg-2 sm:flex-1 sm:basis-0">
        This workspace includes seeded sample history so every page has something to show. Sample rows are badged and excluded from goals, totals and spend.
      </p>
      <div className="flex items-center gap-1.5">
        <ClearSampleButton size="xs" variant="outline" onCleared={dismiss} />
        <button type="button" onClick={dismiss} className="grid size-7 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Dismiss sample data notice">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
