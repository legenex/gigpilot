import Link from "next/link";
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import { TargetMeter, cn } from "@gigpilot/ui";
import { fmtDate } from "@/lib/format";
import type { CommandCenterData } from "@/lib/queries/command-center";

type Status = "ahead" | "on" | "behind" | "nodata" | "progress";

function statusFor(value: number | null, min: number, max: number, lowerIsBetter = false): Status {
  if (value === null) return "nodata";
  if (lowerIsBetter) return value <= max ? "on" : "behind";
  if (value > max) return "ahead";
  if (value >= min) return "on";
  return "behind";
}

const STATUS: Record<Status, { label: string; className: string; icon: React.ReactNode }> = {
  ahead: { label: "Above target", className: "text-profit", icon: <CircleCheck className="size-3.5" strokeWidth={1.75} /> },
  on: { label: "On target", className: "text-profit", icon: <CircleCheck className="size-3.5" strokeWidth={1.75} /> },
  behind: { label: "Below target", className: "text-warn", icon: <TriangleAlert className="size-3.5" strokeWidth={1.75} /> },
  progress: { label: "In progress", className: "text-fg-2", icon: <CircleDashed className="size-3.5" strokeWidth={1.75} /> },
  nodata: { label: "No data yet", className: "text-fg-3", icon: <CircleDashed className="size-3.5" strokeWidth={1.75} /> },
};

/**
 * Operating goals from tenant settings, shown as target band vs actual.
 * Sample history never counts (see lib/queries/tenant.ts).
 */
export function OperatingGoals({ data }: { data: CommandCenterData }) {
  const g = data.settings.goals;
  const acc = data.accuracy;
  const errPct = acc.meanAbsErr === null ? null : Math.round(acc.meanAbsErr * 1000) / 10;
  const touch = data.touchpoints.jobs > 0 ? Math.round((data.touchpoints.touches / data.touchpoints.jobs) * 10) / 10 : null;
  const ws = data.workspace;
  const windowOpen = ws.day <= 30;
  const windowEnd = new Date(ws.createdAt.getTime() + 30 * 86_400_000);

  const rows: {
    key: string;
    label: string;
    helper: string;
    value: number | null;
    display: string;
    min: number;
    max: number;
    scaleMax: number;
    lowerIsBetter?: boolean;
    status?: Status;
  }[] = [
    {
      key: "viable",
      label: "Viable opportunities / day",
      helper: `target ${g.viableOpportunitiesPerDay.min}–${g.viableOpportunitiesPerDay.max} · 7-day avg ${data.counts.viable7dAvg.toFixed(1)}`,
      value: data.counts.viable24h,
      display: String(data.counts.viable24h),
      min: g.viableOpportunitiesPerDay.min,
      max: g.viableOpportunitiesPerDay.max,
      scaleMax: g.viableOpportunitiesPerDay.max * 1.3,
    },
    {
      key: "pursue",
      label: "Pursue-worthy / day",
      helper: `target ${g.pursueWorthyPerDay.min}–${g.pursueWorthyPerDay.max} · last 24h`,
      value: data.counts.pursue24h,
      display: String(data.counts.pursue24h),
      min: g.pursueWorthyPerDay.min,
      max: g.pursueWorthyPerDay.max,
      scaleMax: g.pursueWorthyPerDay.max * 1.6,
    },
    {
      key: "jobs",
      label: "Paid jobs · first 30 days",
      helper: `target ${g.paidJobsFirst30Days.min}–${g.paidJobsFirst30Days.max} · won since ${fmtDate(ws.createdAt)} · ${windowOpen ? `day ${ws.day} of 30` : `window ended ${fmtDate(windowEnd)}`}`,
      value: data.counts.paidJobsFirst30,
      display: String(data.counts.paidJobsFirst30),
      min: g.paidJobsFirst30Days.min,
      max: g.paidJobsFirst30Days.max,
      scaleMax: g.paidJobsFirst30Days.max * 2,
      status: windowOpen && data.counts.paidJobsFirst30 < g.paidJobsFirst30Days.min ? "progress" : undefined,
    },
    {
      key: "accuracy",
      label: "Cost estimate accuracy",
      helper: `target within ±${g.costEstimateAccuracyPct}% · ${acc.jobs ? `${acc.withinTarget}/${acc.jobs} completed jobs within target` : "measured on completed jobs"}`,
      value: errPct,
      display: errPct === null ? "—" : `±${errPct}%`,
      min: 0,
      max: g.costEstimateAccuracyPct,
      scaleMax: g.costEstimateAccuracyPct * 2.5,
      lowerIsBetter: true,
    },
    {
      key: "touch",
      label: "Owner touchpoints / job",
      helper: `target ≤ ${g.ownerTouchpointsPerJob} · ${data.touchpoints.jobs ? `${data.touchpoints.touches} decisions across ${data.touchpoints.jobs} job${data.touchpoints.jobs === 1 ? "" : "s"}` : "measured on won jobs"}`,
      value: touch,
      display: touch === null ? "—" : String(touch),
      min: 0,
      max: g.ownerTouchpointsPerJob,
      scaleMax: g.ownerTouchpointsPerJob * 2.5,
      lowerIsBetter: true,
    },
  ];

  return (
    <div>
      <div className="hairline-b mb-1 flex items-center gap-3 pb-2">
        <h2 className="text-[13px] font-semibold text-fg">Operating goals</h2>
        <span className="hidden text-xs text-fg-3 sm:inline">target band vs actual</span>
        <Link href="/settings#goals" className="ml-auto rounded-sm text-xs text-fg-3 hover:text-fg">
          Edit targets
        </Link>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const s = r.status ?? statusFor(r.value, r.min, r.max, r.lowerIsBetter);
          const st = STATUS[s];
          return (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(120px,1fr)_60px_104px]">
              <div className="min-w-0">
                <p className="text-[13px] text-fg">{r.label}</p>
                <p className="text-[11px] leading-4 text-fg-3">{r.helper}</p>
              </div>
              <p className="text-right text-[18px] font-semibold tracking-[-0.02em] text-fg lg:order-3 lg:text-[16px]">{r.display}</p>
              <div className="col-span-2 lg:order-2 lg:col-span-1">
                {r.value === null ? (
                  <div className="h-px bg-line-strong" aria-hidden />
                ) : (
                  <TargetMeter value={r.value} min={r.min} max={r.max} scaleMax={r.scaleMax} lowerIsBetter={r.lowerIsBetter} label={`${r.label}: ${r.display}, ${r.helper}`} />
                )}
              </div>
              <p className={cn("col-span-2 inline-flex items-center gap-1 text-xs font-medium lg:order-4 lg:col-span-1 lg:justify-end", st.className)}>
                {st.icon}
                {st.label}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
