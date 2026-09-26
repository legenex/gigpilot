import { cookies } from "next/headers";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/lib/session";
import { getLatestSeq, getNavCounts } from "@/lib/queries/shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireSession();
  const [counts, latestSeq, jar] = await Promise.all([getNavCounts(ctx.tenantId), getLatestSeq(ctx.tenantId), cookies()]);
  return (
    <AppShell
      user={{ name: ctx.user.name, email: ctx.user.email }}
      tenantName={ctx.tenantName}
      tenantMode={ctx.tenantMode}
      counts={counts}
      initialSeq={latestSeq}
      initialCollapsed={jar.get("gp_rail")?.value === "collapsed"}
    >
      {children}
    </AppShell>
  );
}
