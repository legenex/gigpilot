import Link from "next/link";
import { Button } from "@gigpilot/ui";

export default function DashboardNotFound() {
  return (
    <div className="page">
      <div className="mx-auto mt-16 max-w-md">
        <p className="eyebrow mb-2">404</p>
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-fg">Nothing on this heading</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-2">It may have been archived, or it belongs to another workspace.</p>
        <div className="mt-5 flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/radar">Opportunity Radar</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Command Center</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
