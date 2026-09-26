"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, CircleAlert, Lock } from "lucide-react";
import { tenantSettingsSchema, type TenantSettings } from "@gigpilot/contracts";
import { Button, Callout, Input, Slider, Switch, cn, formatUsd } from "@gigpilot/ui";
import { updateSettingsAction } from "@/lib/actions/settings";
import { useAction } from "@/lib/use-action";

type Errors = Record<string, string>;

const SECTIONS = [
  { id: "sourcing", label: "Sourcing" },
  { id: "thresholds", label: "Business thresholds" },
  { id: "economics", label: "Economics" },
  { id: "fees", label: "Platform fees" },
  { id: "autonomy", label: "Autonomy" },
  { id: "routing", label: "Routing" },
  { id: "limits", label: "Limits & spend" },
  { id: "goals", label: "Operating goals" },
];

const FAMILIES = [
  { key: "factory", label: "Factory.ai", hint: "cloud reasoning (paid)" },
  { key: "gx", label: "GX cluster", hint: "local compute ($0)" },
  { key: "grok", label: "Grok / xAI", hint: "web research (paid)" },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cur[k] = { ...(cur[k] as Record<string, unknown>) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Numeric input that keeps the raw text while typing; `scale` converts fractions to percent. */
function NumberInput({
  id,
  value,
  onChange,
  prefix,
  suffix,
  scale = 1,
  step,
  error,
  testId,
  width = "w-28",
}: {
  id: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  scale?: number;
  step?: number;
  error?: string;
  testId?: string;
  width?: string;
}) {
  const shown = Math.round(value * scale * 1000) / 1000;
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      step={step ?? "any"}
      prefix={prefix}
      suffix={suffix}
      value={text ?? String(shown)}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n / scale);
      }}
      onBlur={() => setText(null)}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-error` : undefined}
      className={cn(width, "text-right [&_input]:text-right")}
      data-testid={testId}
    />
  );
}

function Row({ id, label, hint, error, children }: { id?: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-2 border-t border-line py-3.5 first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <div>
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs leading-5 text-fg-3">{hint}</p> : null}
      </div>
      <div className="flex flex-col items-start gap-1 md:items-end">
        <div className="flex flex-wrap items-center gap-2 md:justify-end">{children}</div>
        {error ? (
          <p id={id ? `${id}-error` : undefined} className="text-xs text-risk" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Group({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <div className="hairline-b mb-1 pb-2">
        <h2 id={`${id}-title`} className="text-[15px] font-semibold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-0.5 max-w-2xl text-xs leading-5 text-fg-3">{description}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SettingsForm({ initial, envBudgetUsd, feeKeys }: { initial: TenantSettings; envBudgetUsd: number; feeKeys: string[] }) {
  const [s, setS] = useState<TenantSettings>(() => clone(initial));
  const [base, setBase] = useState<TenantSettings>(() => clone(initial));
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const { run, pending } = useAction();

  const dirty = useMemo(() => JSON.stringify(s) !== JSON.stringify(base), [s, base]);

  const errors = useMemo<Errors>(() => {
    const e: Errors = {};
    const parsed = tenantSettingsSchema.safeParse(s);
    if (!parsed.success) for (const i of parsed.error.issues) e[i.path.join(".")] ??= i.message.replace(/^Too (big|small): expected number to be /, "Must be ");
    const g = s.goals;
    for (const k of ["viableOpportunitiesPerDay", "pursueWorthyPerDay", "paidJobsFirst30Days"] as const) {
      if (g[k].min > g[k].max) e[`goals.${k}.max`] = "Max must be at least the min.";
    }
    if (s.routing.allowedModelFamilies.length === 0) e["routing.allowedModelFamilies"] = "Allow at least one model family (GX is free and local).";
    return { ...e, ...serverErrors };
  }, [s, serverErrors]);
  const errorCount = Object.keys(errors).length;

  const set = (path: string, value: unknown) => {
    setS((prev) => {
      const next = clone(prev) as unknown as Record<string, unknown>;
      setPath(next, path, value);
      return next as unknown as TenantSettings;
    });
    if (serverErrors[path]) setServerErrors(({ [path]: _, ...rest }) => rest);
  };

  const save = () => {
    if (errorCount) return;
    run(() => updateSettingsAction(s), {
      onSuccess: () => {
        setBase(clone(s));
        setServerErrors({});
      },
      onError: (msg) => {
        const map: Errors = {};
        for (const part of msg.split("; ")) {
          const m = /^([a-zA-Z0-9_.]+):\s*(.+)$/.exec(part);
          if (m) map[m[1]!] = m[2]!;
        }
        setServerErrors(map);
      },
    });
  };

  const e = (p: string) => errors[p];
  const pct = (path: string, v: number, testId?: string, step = 1) => <NumberInput id={path} value={v} onChange={(n) => set(path, n)} suffix="%" scale={100} step={step} error={e(path)} testId={testId} width="w-24" />;
  const usd = (path: string, v: number, testId?: string) => <NumberInput id={path} value={v} onChange={(n) => set(path, n)} prefix="$" step={1} error={e(path)} testId={testId} />;
  const int = (path: string, v: number, suffix?: string) => <NumberInput id={path} value={v} onChange={(n) => set(path, Math.round(n))} suffix={suffix} step={1} error={e(path)} width="w-24" />;
  const range = (path: string, v: { min: number; max: number }) => (
    <>
      <NumberInput id={`${path}.min`} value={v.min} onChange={(n) => set(`${path}.min`, n)} step={1} error={e(`${path}.min`)} width="w-20" />
      <span className="text-xs text-fg-3">to</span>
      <NumberInput id={`${path}.max`} value={v.max} onChange={(n) => set(`${path}.max`, n)} step={1} error={e(`${path}.max`)} width="w-20" />
    </>
  );
  const pref = s.routing.creativeProviderPreference;
  const paidOn = envBudgetUsd > 0 && s.limits.dailyPaidSpendLimitUsd > 0;

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[180px_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="hidden lg:block">
        <ul className="sticky top-6 flex flex-col gap-0.5">
          {SECTIONS.map((x) => (
            <li key={x.id}>
              <a href={`#${x.id}`} className="block rounded-sm px-2.5 py-1.5 text-[13px] text-fg-3 hover:bg-surface-1 hover:text-fg">
                {x.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <form
        className="flex min-w-0 max-w-[880px] flex-col gap-10 pb-24"
        onSubmit={(ev) => {
          ev.preventDefault();
          save();
        }}
        noValidate
      >
        <Group id="sourcing" title="Sourcing" description="Which markets the Scout covers and how much effort each gets lives in Market Lab.">
          <Row label="Markets & allocation" hint="Enable service families and set their share of sourcing effort.">
            <Button asChild variant="outline" size="sm">
              <Link href="/markets">
                Open Market Lab <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </Row>
          <Row id="sourcing.refreshIntervalMinutes" label="Refresh interval" hint="How often permitted sources are polled. Sources with stricter rules (e.g. Upwork: user-directed only) are never polled faster than their policy allows." error={e("sourcing.refreshIntervalMinutes")}>
            {int("sourcing.refreshIntervalMinutes", s.sourcing.refreshIntervalMinutes, "min")}
          </Row>
          <Row id="sourcing.opportunityMaxAgeHours" label="Opportunity max age" hint="Older listings expire from the Radar." error={e("sourcing.opportunityMaxAgeHours")}>
            {int("sourcing.opportunityMaxAgeHours", s.sourcing.opportunityMaxAgeHours, "h")}
          </Row>
        </Group>

        <Group id="thresholds" title="Business thresholds" description="Hard gates for “pursue”. Profit and margin are hard gates; budget is a soft gate that downgrades to “consider”.">
          <Row id="thresholds.minGrossMargin" label="Minimum gross margin" hint="After production, contingencies, owner time and platform fees." error={e("thresholds.minGrossMargin")}>
            {pct("thresholds.minGrossMargin", s.thresholds.minGrossMargin, "settings-min-margin")}
          </Row>
          <Row id="thresholds.minExpectedProfitUsd" label="Minimum expected profit" error={e("thresholds.minExpectedProfitUsd")}>
            {usd("thresholds.minExpectedProfitUsd", s.thresholds.minExpectedProfitUsd, "settings-min-profit")}
          </Row>
          <Row id="thresholds.preferredMinBudgetUsd" label="Preferred minimum budget" hint="Soft gate." error={e("thresholds.preferredMinBudgetUsd")}>
            {usd("thresholds.preferredMinBudgetUsd", s.thresholds.preferredMinBudgetUsd, "settings-min-budget")}
          </Row>
        </Group>

        <Group id="economics" title="Economics" description="Inputs to the deterministic calculator. Models only estimate quantities — every dollar comes from here and the price catalog.">
          <Row id="economics.shadowHourlyRateUsd" label="Shadow hourly cost" hint="Values your review and coordination time as a real cost." error={e("economics.shadowHourlyRateUsd")}>
            {usd("economics.shadowHourlyRateUsd", s.economics.shadowHourlyRateUsd)}
            <span className="text-xs text-fg-3">/h</span>
          </Row>
          <Row id="economics.contingencyPct" label="General contingency" hint="Applied to fulfilment + revision contingency." error={e("economics.contingencyPct")}>
            {pct("economics.contingencyPct", s.economics.contingencyPct)}
          </Row>
          <Row id="economics.expectedRevisionRounds" label="Expected revision rounds" error={e("economics.expectedRevisionRounds")}>
            <NumberInput id="economics.expectedRevisionRounds" value={s.economics.expectedRevisionRounds} onChange={(n) => set("economics.expectedRevisionRounds", n)} step={0.5} error={e("economics.expectedRevisionRounds")} width="w-24" />
          </Row>
          <Row id="economics.revisionCostFraction" label="Cost per revision round" hint="As a share of first-pass production cost." error={e("economics.revisionCostFraction")}>
            {pct("economics.revisionCostFraction", s.economics.revisionCostFraction)}
          </Row>
          <Row id="economics.defaultHourlyRateUsd" label="Default hourly rate" hint="Used to price hourly opportunities (clamped to the client’s range)." error={e("economics.defaultHourlyRateUsd")}>
            {usd("economics.defaultHourlyRateUsd", s.economics.defaultHourlyRateUsd)}
            <span className="text-xs text-fg-3">/h</span>
          </Row>
        </Group>

        <Group id="fees" title="Platform fees" description="Charged to you by each marketplace. Verify against the marketplace’s current terms.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">
                  <th className="py-2 text-left font-medium">Source</th>
                  <th className="py-2 text-right font-medium">Percent</th>
                  <th className="py-2 text-right font-medium">Fixed</th>
                  <th className="py-2 text-right font-medium">Minimum</th>
                  <th className="py-2 pl-4 text-left font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {feeKeys.map((k) => {
                  const f = s.economics.platformFees[k] ?? { pct: 0, fixedUsd: 0, minUsd: 0 };
                  const p = `economics.platformFees.${k}`;
                  return (
                    <tr key={k} className="h-11">
                      <td className="capitalize text-fg">{k === "mock" ? "Demo" : k}</td>
                      <td className="text-right">
                        <span className="inline-flex justify-end">
                          <NumberInput id={`${p}.pct`} value={f.pct} onChange={(n) => set(p, { ...f, pct: n })} suffix="%" scale={100} step={0.5} error={e(`${p}.pct`)} width="w-24" />
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="inline-flex justify-end">
                          <NumberInput id={`${p}.fixedUsd`} value={f.fixedUsd} onChange={(n) => set(p, { ...f, fixedUsd: n })} prefix="$" step={0.01} error={e(`${p}.fixedUsd`)} width="w-24" />
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="inline-flex justify-end">
                          <NumberInput id={`${p}.minUsd`} value={f.minUsd} onChange={(n) => set(p, { ...f, minUsd: n })} prefix="$" step={1} error={e(`${p}.minUsd`)} width="w-24" />
                        </span>
                      </td>
                      <td className="max-w-[240px] truncate pl-4 text-xs text-fg-3" title={f.note}>
                        {f.note ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Group>

        <Group id="autonomy" title="Autonomy" description="What GigPilot may do without asking. Marketplace submissions and pricing commitments always stay behind your approval.">
          <p className="eyebrow mt-3">Application autonomy</p>
          <Row id="autonomy.requireOpportunityApproval" label="Require approval to pursue an opportunity" hint="Off: pursue-worthy opportunities go straight to proposal drafting.">
            <Switch id="autonomy.requireOpportunityApproval" checked={s.autonomy.requireOpportunityApproval} onCheckedChange={(v) => set("autonomy.requireOpportunityApproval", v)} label="Require approval to pursue" />
          </Row>
          <Row id="autonomy.requireProposalApproval" label="Require approval of proposal, price and scope" hint="Commercial commitments always need you — this gate can’t be switched off.">
            <span className="inline-flex items-center gap-2 text-xs text-fg-3">
              <Lock className="size-3.5" /> Always on
            </span>
            <Switch id="autonomy.requireProposalApproval" checked disabled onCheckedChange={() => {}} label="Require proposal approval (locked)" />
          </Row>
          <Row id="autonomy.autoSubmitWhenPermitted" label="Submit automatically after approval where officially permitted" hint="Only marketplaces with an official submission API (e.g. Freelancer bids). Others stay manual.">
            <Switch id="autonomy.autoSubmitWhenPermitted" checked={s.autonomy.autoSubmitWhenPermitted} onCheckedChange={(v) => set("autonomy.autoSubmitWhenPermitted", v)} label="Auto-submit where permitted" />
          </Row>
          <p className="eyebrow mt-5">Production autonomy</p>
          <Row id="autonomy.autoRepairWithinLimits" label="Repair automatically within limits" hint="Recovery Agent may repair, regenerate or reroute within the job’s spend, attempt and repair limits.">
            <Switch id="autonomy.autoRepairWithinLimits" checked={s.autonomy.autoRepairWithinLimits} onCheckedChange={(v) => set("autonomy.autoRepairWithinLimits", v)} label="Auto-repair within limits" />
          </Row>
          <p className="eyebrow mt-5">Final-delivery policy</p>
          <Row id="autonomy.requireFinalDeliveryApproval" label="Require approval of final delivery" hint="Recommended. Off: packages release once QA passes.">
            <Switch id="autonomy.requireFinalDeliveryApproval" checked={s.autonomy.requireFinalDeliveryApproval} onCheckedChange={(v) => set("autonomy.requireFinalDeliveryApproval", v)} label="Require final delivery approval" />
          </Row>
          <Row id="autonomy.autoSendClientMessages" label="Send client messages automatically" hint="Off by default. When off, client messages are drafted for you to send.">
            <Switch id="autonomy.autoSendClientMessages" checked={s.autonomy.autoSendClientMessages} onCheckedChange={(v) => set("autonomy.autoSendClientMessages", v)} label="Auto-send client messages" />
          </Row>
        </Group>

        <Group id="routing" title="Routing" description="How the model router and creative broker choose providers.">
          <Row label="Creative provider preference" hint="Tie-breaker order. The broker still picks the cheapest route predicted to clear the quality bar.">
            <ol className="flex w-full flex-col gap-1 md:w-64">
              {pref.map((p, i) => (
                <li key={p} className="flex h-8 items-center gap-2 rounded-sm bg-surface-1 px-2.5 ring-1 ring-inset ring-line">
                  <span className="font-mono text-[11px] text-fg-3">{i + 1}</span>
                  <span className="flex-1 text-[13px] capitalize text-fg">{p}</span>
                  <button type="button" className="grid size-6 place-items-center rounded-xs text-fg-3 hover:bg-surface-3 hover:text-fg disabled:opacity-30" disabled={i === 0} aria-label={`Move ${p} up`} onClick={() => { const n = [...pref]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; set("routing.creativeProviderPreference", n); }}>
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button type="button" className="grid size-6 place-items-center rounded-xs text-fg-3 hover:bg-surface-3 hover:text-fg disabled:opacity-30" disabled={i === pref.length - 1} aria-label={`Move ${p} down`} onClick={() => { const n = [...pref]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; set("routing.creativeProviderPreference", n); }}>
                    <ArrowDown className="size-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          </Row>
          <Row id="routing.creativeQualityThreshold" label="Creative quality bar" hint="Minimum predicted quality (0–1) a route must clear." error={e("routing.creativeQualityThreshold")}>
            <Slider value={s.routing.creativeQualityThreshold} onValueChange={(v) => set("routing.creativeQualityThreshold", Math.round(v * 100) / 100)} min={0.5} max={0.95} step={0.01} label="Creative quality threshold" className="w-40" />
            <span className="w-10 text-right font-mono text-xs tabular text-fg">{s.routing.creativeQualityThreshold.toFixed(2)}</span>
          </Row>
          <Row label="Allowed model families" hint="The router never calls a family you exclude. Mock stays available for test mode." error={e("routing.allowedModelFamilies")}>
            <div className="flex flex-wrap gap-1.5 md:justify-end" role="group" aria-label="Allowed model families">
              {FAMILIES.map((f) => {
                const on = s.routing.allowedModelFamilies.includes(f.key);
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("routing.allowedModelFamilies", on ? s.routing.allowedModelFamilies.filter((x) => x !== f.key) : [...s.routing.allowedModelFamilies, f.key])}
                    className={cn("flex flex-col items-start rounded-sm px-2.5 py-1.5 text-left ring-1 ring-inset transition-colors", on ? "bg-surface-2 ring-line-bright" : "ring-line hover:ring-line-strong")}
                  >
                    <span className={cn("text-xs font-medium", on ? "text-fg" : "text-fg-3")}>
                      {on ? "✓ " : ""}
                      {f.label}
                    </span>
                    <span className="text-[10.5px] text-fg-3">{f.hint}</span>
                  </button>
                );
              })}
            </div>
          </Row>
          <Row id="routing.preferLocalForCheapTasks" label="Prefer local GX for cheap tasks" hint="Triage, extraction and first-pass QA run on the GX cluster when healthy.">
            <Switch id="routing.preferLocalForCheapTasks" checked={s.routing.preferLocalForCheapTasks} onCheckedChange={(v) => set("routing.preferLocalForCheapTasks", v)} label="Prefer local GX" />
          </Row>
        </Group>

        <Group id="limits" title="Limits & spend" description="Hard guardrails enforced by the orchestrator before every paid call.">
          <Row id="limits.dailyPaidSpendLimitUsd" label="Daily paid spend limit" hint="Workspace cap for real-money provider calls per day." error={e("limits.dailyPaidSpendLimitUsd")}>
            {usd("limits.dailyPaidSpendLimitUsd", s.limits.dailyPaidSpendLimitUsd)}
          </Row>
          <Callout tone={paidOn ? "warn" : "info"} icon={<CircleAlert />} title={paidOn ? "Paid providers can be called" : "Paid providers stay off"} className="mb-2 mt-1">
            Paid providers run only while <strong className="font-medium text-fg">both</strong> this limit and the server budget (<code className="font-mono">PAID_PROVIDER_DAILY_BUDGET_USD</code>, currently{" "}
            <span className="font-mono text-fg">{formatUsd(envBudgetUsd, { cents: true })}</span>) are above $0. {paidOn ? "The lower of the two applies." : "Until then all creative and reasoning work uses mock providers at $0 — safe for testing."}
          </Callout>
          <Row id="limits.perJobSpendLimitUsd" label="Per-job spend limit" hint="Maximum authorised production spend for any single job." error={e("limits.perJobSpendLimitUsd")}>
            {usd("limits.perJobSpendLimitUsd", s.limits.perJobSpendLimitUsd)}
          </Row>
          <Row id="limits.maxStepAttempts" label="Max attempts per step" hint="First attempt included. Failed attempts are recorded, never overwritten." error={e("limits.maxStepAttempts")}>
            {int("limits.maxStepAttempts", s.limits.maxStepAttempts)}
          </Row>
          <Row id="limits.maxRepairsPerJob" label="Max repairs per job" error={e("limits.maxRepairsPerJob")}>
            {int("limits.maxRepairsPerJob", s.limits.maxRepairsPerJob)}
          </Row>
          <Row id="limits.maxGenerationsPerStep" label="Max generations per step" error={e("limits.maxGenerationsPerStep")}>
            {int("limits.maxGenerationsPerStep", s.limits.maxGenerationsPerStep)}
          </Row>
        </Group>

        <Group id="goals" title="Operating goals" description="Targets shown on the Command Center as target band vs actual.">
          <Row label="Viable opportunities per day" error={e("goals.viableOpportunitiesPerDay.max") ?? e("goals.viableOpportunitiesPerDay.min")}>
            {range("goals.viableOpportunitiesPerDay", s.goals.viableOpportunitiesPerDay)}
          </Row>
          <Row label="Pursue-worthy per day" error={e("goals.pursueWorthyPerDay.max") ?? e("goals.pursueWorthyPerDay.min")}>
            {range("goals.pursueWorthyPerDay", s.goals.pursueWorthyPerDay)}
          </Row>
          <Row label="Paid jobs in the first 30 days" error={e("goals.paidJobsFirst30Days.max") ?? e("goals.paidJobsFirst30Days.min")}>
            {range("goals.paidJobsFirst30Days", s.goals.paidJobsFirst30Days)}
          </Row>
          <Row id="goals.costEstimateAccuracyPct" label="Cost estimate accuracy" hint="Actual cost within ± this percentage of the estimate." error={e("goals.costEstimateAccuracyPct")}>
            <NumberInput id="goals.costEstimateAccuracyPct" value={s.goals.costEstimateAccuracyPct} onChange={(n) => set("goals.costEstimateAccuracyPct", n)} prefix="±" suffix="%" step={1} error={e("goals.costEstimateAccuracyPct")} width="w-24" />
          </Row>
          <Row id="goals.ownerTouchpointsPerJob" label="Owner touchpoints per job" hint="Decisions you make per won job (target maximum)." error={e("goals.ownerTouchpointsPerJob")}>
            {int("goals.ownerTouchpointsPerJob", s.goals.ownerTouchpointsPerJob)}
          </Row>
        </Group>

        <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-3 rounded-md bg-surface-2/95 px-4 py-2.5 shadow-3 ring-1 ring-inset ring-line-strong backdrop-blur" role="region" aria-label="Save settings">
          <span className={cn("text-xs", errorCount ? "text-risk" : dirty ? "text-fg-2" : "text-fg-3")} aria-live="polite">
            {errorCount ? `${errorCount} field${errorCount === 1 ? "" : "s"} need${errorCount === 1 ? "s" : ""} attention` : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={!dirty || pending} onClick={() => { setS(clone(base)); setServerErrors({}); }}>
              Discard
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!dirty || errorCount > 0} data-testid="settings-save">
              Save changes
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
