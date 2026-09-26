"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@gigpilot/ui";

export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="page">
      <div className="mx-auto mt-16 max-w-md rounded-md p-6 ring-1 ring-inset ring-line">
        <TriangleAlert className="mb-3 size-5 text-warn" strokeWidth={1.75} />
        <h1 className="font-display text-[18px] font-semibold tracking-[-0.015em] text-fg">This view failed to load</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-2">
          Agents keep running in the background — nothing was lost. Try again, or head back to the Command Center.
        </p>
        {error.digest ? <p className="mt-3 font-mono text-[11px] text-fg-3">ref {error.digest}</p> : null}
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={() => retry()}>
            <RotateCcw className="size-3.5" /> Try again
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Command Center</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
