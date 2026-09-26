import Link from "next/link";
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import { TargetMeter, cn } from "@gigpilot/ui";
import type { CommandCenterData } from "@/lib/queries/command-center";

type Status = "ahead" | "on" | "behind" | "nodata";

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
  nodata: { label: "No data yet", className: "text-fg-3", icon: <CircleDashed className="size-3.5" strokeWidth={1.75} /> },
};

/** Operating goals from tenant settings, shown as target band vs actual. */
export function OperatingGoals({ data }: { data: CommandCenterData }) {
  const g = data.settings.goals;
  const acc = data.accuracy;
  const errPct = acc.meanAbsErr === null ? null : Math.round(acc.meanAbsErr * 1000) / 10;
  const touch = data.touchpoints.jobs > 0 ? Math.round((data.touchpoints.touches / data.touchpoints.jobs) * 10) / 10 : null;

  const rows: {
    key: string;
    label: string;
    target: string;
    value: number | null;
    display: string;
    sub: string;
    min: number;
    max: number;
    scaleMax: number;
    lowerIsBetter?: boolean;
  }[] = [
    {
      key: "viable",
      label: "Viable opportunities / day",
      target: `${g.viableOpportunitiesPerDay.min}–${g.viableOpportunitiesPerDay.max}`,
      value: data.counts.viable24h,
      display: String(data.counts.viable24h),
      sub: `7-day avg ${data.counts.viable7dAvg.toFixed(1)}`,
      min: g.viableOpportunitiesPerDay.min,
      max: g.viableOpportunitiesPerDay.max,
      scaleMax: g.viableOpportunitiesPerDay.max * 1.3,
    },
    {
      key: "pursue",
      label: "Pursue-worthy / day",
      target: `${g.pursueWorthyPerDay.min}–${g.pursueWorthyPerDay.max}`,
      value: data.counts.pursue24h,
      display: String(data.counts.pursue24h),
      sub: "last 24h",
      min: g.pursueWorthyPerDay.min,
      max: g.pursueWorthyPerDay.max,
      scaleMax: g.pursueWorthyPerDay.max * 1.6,
    },
    {
      key: "jobs",
      label: "Paid jobs · first 30 days",
      target: `${g.paidJobsFirst30Days.min}–${g.paidJobsFirst30Days.max}`,
      value: data.counts.jobs30d,
      display: String(data.counts.jobs30d),
      sub: "won in last 30 days",
      min: g.paidJobsFirst30Days.min,
      max: g.paidJobsFirst30Days.max,
      scaleMax: g.paidJobsFirst30Days.max * 2,
    },
    {
      key: "accuracy",
      label: "Cost estimate accuracy",
      target: `within ±${g.costEstimateAccuracyPct}%`,
      value: errPct,
      display: errPct === null ? "—" : `±${errPct}%`,
      sub: acc.jobs ? `${acc.withinTarget}/${acc.jobs} jobs within target` : "measured on completed jobs",
      min: 0,
      max: g.costEstimateAccuracyPct,
      scaleMax: g.costEstimateAccuracyPct * 2.5,
      lowerIsBetter: true,
    },
    {
      key: "touch",
      label: "Owner touchpoints / job",
      target: `≤ ${g.ownerTouchpointsPerJob}`,
      value: touch,
      display: touch === null ? "—" : String(touch),
      sub: data.touchpoints.jobs ? `${data.touchpoints.touches} decisions across ${data.touchpoints.jobs} jobs` : "measured on won jobs",
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
        <span className="text-xs text-fg-3">target band vs actual</span>
        <Link href="/settings#goals" className="ml-auto text-xs text-fg-3 hover:text-fg">
          Edit targets
        </Link>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const s = statusFor(r.value, r.min, r.max, r.lowerIsBetter);
          const st = STATUS[s];
          return (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-3 md:grid-cols-[minmax(170px,1.1fr)_minmax(140px,1.4fr)_64px_112px]">
              <div className="min-w-0">
                <p className="truncate text-[13px] text-fg">{r.label}</p>
                <p className="font-mono text-[11px] text-fg-3">target {r.target}</p>
              </div>
              <div className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto">
                {r.value === null ? (
                  <div className="h-1 rounded-full bg-surface-2" aria-hidden />
                ) : (
                  <TargetMeter value={r.value} min={r.min} max={r.max} scaleMax={r.scaleMax} lowerIsBetter={r.lowerIsBetter} label={`${r.label}: ${r.display}, target ${r.target}`} />
                )}
              </div>
              <p className="text-right text-[18px] font-semibold tracking-[-0.02em] text-fg md:text-[16px]">{r.display}</p>
              <div className="col-span-2 row-start-3 flex items-center justify-between gap-2 md:col-span-1 md:row-start-auto md:block md:text-right">
                <p className={cn("inline-flex items-center gap-1 text-xs font-medium", st.className)}>
                  {st.icon}
                  {st.label}
                </p>
                <p className="truncate text-[11px] text-fg-3">{r.sub}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
