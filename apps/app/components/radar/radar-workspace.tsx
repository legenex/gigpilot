"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  Kbd,
  MiniMeter,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RecChip,
  SegmentedControl,
  Select,
  Skeleton,
  StatusDot,
  TBody,
  TD,
  TH,
  THead,
  TR,
  cn,
  formatPct,
  formatUsd,
} from "@gigpilot/ui";
import { OPPORTUNITY_STATES, type OpportunityState } from "@gigpilot/contracts";
import { SampleBadge } from "@/components/sample/sample-badge";
import { fmtAge, fmtBudget } from "@/lib/format";
import { OPPORTUNITY_META, SOURCE_SHORT, serviceFamilyLabel } from "@/lib/labels";
import type { RadarFilters, RadarRow, SortKey } from "@/lib/queries/radar";
import { isSample } from "@/lib/sample";

interface Props {
  rows: RadarRow[];
  total: number;
  counts: { pursue: number; review: number; all: number };
  markets: { key: string; name: string }[];
  sources: string[];
  filters: RadarFilters;
  pane: ReactNode;
  nowMs: number;
  /** Tenant creation (ISO) — rows created before it are sample history. */
  sampleBefore?: string | null;
}

/**
 * Column priority. `tier` decides the smallest viewport that shows the column;
 * everything hidden still lives in the side pane. Base columns always show.
 */
type Tier = "base" | "lg" | "xl" | "wide" | "2xl" | "max";
type Col = {
  key: string;
  label: string;
  sort?: SortKey;
  align?: "left" | "right";
  tier: Tier;
  className?: string;
  title?: string;
};

const TIER_CLASS: Record<Tier, string> = {
  base: "",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
  wide: "hidden min-[1400px]:table-cell",
  "2xl": "hidden 2xl:table-cell",
  max: "hidden min-[1800px]:table-cell",
};

const COLS: Col[] = [
  { key: "title", label: "Opportunity", sort: "title", tier: "base", className: "min-w-[200px]" },
  { key: "profit", label: "Exp. profit", sort: "profit", align: "right", tier: "base", title: "Expected profit after production, contingencies, owner time and platform fees" },
  { key: "margin", label: "Margin", sort: "margin", align: "right", tier: "base", title: "Margin after owner time" },
  { key: "rec", label: "Rec", sort: "rec", tier: "base", className: "w-[104px]", title: "Recommendation" },
  { key: "budget", label: "Budget", sort: "budget", align: "right", tier: "lg" },
  { key: "cost", label: "Est. cost", sort: "cost", align: "right", tier: "xl", title: "Estimated production + overhead cost (excl. platform fees)" },
  { key: "fees", label: "Fees", sort: "fees", align: "right", tier: "2xl", title: "Platform fees" },
  { key: "deadline", label: "Deadline", sort: "deadline", align: "right", tier: "2xl" },
  { key: "age", label: "Age", sort: "age", align: "right", tier: "lg" },
  { key: "fit", label: "Fit", sort: "fit", align: "right", tier: "xl" },
  { key: "complexity", label: "Complexity", sort: "complexity", align: "right", tier: "max" },
  { key: "rrisk", label: "Rev. risk", sort: "rrisk", align: "right", tier: "max", title: "Revision risk" },
  { key: "drisk", label: "Deadline risk", sort: "drisk", align: "right", tier: "max" },
  { key: "confidence", label: "Confidence", sort: "confidence", align: "right", tier: "wide", title: "Analysis confidence" },
  { key: "status", label: "Status", sort: "status", tier: "wide" },
  { key: "source", label: "Source", sort: "source", tier: "2xl", className: "w-[84px]" },
];

const DEFAULT_DIR: Partial<Record<SortKey, "asc" | "desc">> = { source: "asc", title: "asc", client: "asc", market: "asc", deadline: "asc", age: "asc", status: "asc" };

export function RadarWorkspace({ rows, total, counts, markets, sources, filters, pane, nowMs, sampleBefore }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [pendingSel, setPendingSel] = useState<string | null>(null);
  const [q, setQ] = useState(filters.q ?? "");
  const tableRef = useRef<HTMLDivElement>(null);
  const sel = filters.sel ?? null;

  const hrefWith = useCallback(
    (patch: Record<string, string | undefined | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === "") sp.delete(k);
        else sp.set(k, v);
      }
      const s = sp.toString();
      return s ? `${pathname}?${s}` : pathname;
    },
    [params, pathname],
  );

  const navigate = useCallback(
    (patch: Record<string, string | undefined | null>, mode: "push" | "replace" = "replace") => {
      if ("sel" in patch) setPendingSel(patch.sel ?? null);
      startTransition(() => {
        if (mode === "push") router.push(hrefWith(patch), { scroll: false });
        else router.replace(hrefWith(patch), { scroll: false });
      });
    },
    [hrefWith, router],
  );

  // Debounced search → URL.
  useEffect(() => {
    if ((filters.q ?? "") === q) return;
    const t = window.setTimeout(() => navigate({ q: q || undefined }), 300);
    return () => window.clearTimeout(t);
  }, [q, filters.q, navigate]);

  // j/k/Enter/Esc keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && sel) {
        navigate({ sel: undefined });
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      if (!rows.length) return;
      e.preventDefault();
      const idx = sel ? rows.findIndex((r) => r.id === sel) : -1;
      const next = e.key === "j" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
      const id = rows[next]?.id;
      if (id && id !== sel) {
        navigate({ sel: id });
        const el = [...(tableRef.current?.querySelectorAll<HTMLElement>(`[data-opportunity-id="${id}"]`) ?? [])].find((x) => x.offsetParent !== null);
        el?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, sel, navigate]);

  const compact = Boolean(sel);
  const advancedActive = [filters.bmin, filters.bmax, filters.pmin, filters.mmin, filters.cmin, filters.age, filters.risk].filter((v) => v !== undefined).length;
  const anyFilter = advancedActive > 0 || filters.q || filters.source || filters.market || filters.status;

  const chips = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    if (filters.bmin !== undefined) out.push({ key: "bmin", label: `Budget ≥ $${filters.bmin}` });
    if (filters.bmax !== undefined) out.push({ key: "bmax", label: `Budget ≤ $${filters.bmax}` });
    if (filters.pmin !== undefined) out.push({ key: "pmin", label: `Profit ≥ $${filters.pmin}` });
    if (filters.mmin !== undefined) out.push({ key: "mmin", label: `Margin ≥ ${filters.mmin}%` });
    if (filters.cmin !== undefined) out.push({ key: "cmin", label: `Confidence ≥ ${filters.cmin}%` });
    if (filters.risk) out.push({ key: "risk", label: filters.risk === "low" ? "Low risk only" : "Risk ≤ medium" });
    if (filters.age !== undefined) out.push({ key: "age", label: `Age ≤ ${filters.age >= 48 ? `${Math.round(filters.age / 24)}d` : `${filters.age}h`}` });
    return out;
  }, [filters]);

  const sortHref = (key: SortKey) => {
    const active = filters.sort === key;
    const dir = active ? (filters.dir === "asc" ? "desc" : "asc") : (DEFAULT_DIR[key] ?? "desc");
    return hrefWith({ sort: key, dir });
  };

  const selectRow = (id: string) => navigate({ sel: id === sel ? undefined : id }, "push");
  const paneLoading = isPending && pendingSel !== null && pendingSel !== sel;
  // Source is noise when every row comes from the same place.
  const multiSource = new Set(rows.map((r) => r.sourceKey)).size > 1;
  const cols = COLS.filter((c) => (c.key !== "source" || multiSource) && (!compact || c.tier === "base"));
  const other = Math.max(0, counts.all - counts.pursue - counts.review);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Views + counts */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="Quick views"
          value={filters.status ? "" : filters.view}
          items={[
            { value: "pursue", label: "Pursue now", count: counts.pursue, href: hrefWith({ view: "pursue", status: undefined, sort: undefined, dir: undefined }), testId: "radar-view-pursue" },
            { value: "review", label: "Needs review", count: counts.review, href: hrefWith({ view: "review", status: undefined, sort: undefined, dir: undefined }), testId: "radar-view-review" },
            { value: "all", label: "All", count: counts.all, href: hrefWith({ view: "all", status: undefined, sort: undefined, dir: undefined }), testId: "radar-view-all" },
          ]}
        />
        <p className="flex items-center gap-2 text-xs text-fg-3 sm:ml-auto" aria-live="polite">
          {isPending ? <span className="size-3 animate-spin rounded-full border-[1.5px] border-fg-3 border-t-transparent" aria-hidden /> : null}
          <span title="Pursue now and Needs review never overlap; All also includes skipped and decided opportunities.">
            {rows.length < total ? `Showing ${rows.length} of ${total}` : `${total} shown`} · All = {counts.pursue} pursue + {counts.review} review + {other} skipped or decided
          </span>
          <span className="hidden items-center gap-1 xl:flex">
            · <Kbd>J</Kbd>
            <Kbd>K</Kbd> to move
          </span>
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter opportunities">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, client, brief…" aria-label="Search opportunities" className="pl-8" />
        </div>
        <Select selectSize="md" aria-label="Source" value={filters.source ?? ""} onChange={(e) => navigate({ source: e.target.value || undefined })} className="min-w-[132px] flex-1 sm:w-[132px] sm:flex-none">
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_SHORT[s] ?? s}
            </option>
          ))}
        </Select>
        <Select aria-label="Service type" value={filters.market ?? ""} onChange={(e) => navigate({ market: e.target.value || undefined })} className="min-w-[160px] flex-1 sm:w-[184px] sm:flex-none">
          <option value="">All service types</option>
          {markets.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={filters.status ?? ""} onChange={(e) => navigate({ status: e.target.value || undefined })} className="min-w-[132px] flex-1 sm:w-[132px] sm:flex-none">
          <option value="">Any status</option>
          {OPPORTUNITY_STATES.filter((s) => s !== "archived").map((s) => (
            <option key={s} value={s}>
              {OPPORTUNITY_META[s].label}
            </option>
          ))}
        </Select>
        <AdvancedFilters filters={filters} onApply={(patch) => navigate(patch)} activeCount={advancedActive} />
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => navigate({ [c.key]: undefined })}
            className="inline-flex h-7 items-center gap-1 rounded-xs bg-surface-2 pl-2 pr-1.5 text-xs text-fg-2 ring-1 ring-inset ring-line-strong hover:text-fg"
            aria-label={`Remove filter ${c.label}`}
          >
            {c.label}
            <X className="size-3" />
          </button>
        ))}
        {anyFilter ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              navigate({ q: undefined, source: undefined, market: undefined, status: undefined, bmin: undefined, bmax: undefined, pmin: undefined, mmin: undefined, cmin: undefined, risk: undefined, age: undefined });
            }}
          >
            Clear all
          </Button>
        ) : null}
      </div>

      <div className={cn("grid min-w-0 grid-cols-1 gap-5", compact && "xl:grid-cols-[minmax(0,1fr)_minmax(480px,40%)]")}>
        <div ref={tableRef} className={cn("min-w-0 transition-opacity duration-200", isPending && !paneLoading && "opacity-60")}>
          {rows.length === 0 ? (
            <EmptyState
              icon={<ListFilter />}
              title={anyFilter ? "No opportunities match these filters" : filters.view === "pursue" ? "Nothing pursue-worthy right now" : "No opportunities yet"}
              description={
                anyFilter
                  ? "Loosen a filter or clear them to see the full radar."
                  : filters.view === "pursue"
                    ? "Nothing currently clears your profit and margin gates. Check “Needs review”, refresh sources, or paste an opportunity you found."
                    : "Enable a source in Integrations or paste an opportunity to start the pipeline."
              }
              action={
                anyFilter ? (
                  <Button variant="secondary" size="sm" asChild>
                    <Link href="/radar?view=all">Show all</Link>
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" asChild>
                    <Link href="/integrations">Open integrations</Link>
                  </Button>
                )
              }
            />
          ) : (
            <>
              <DataTable
                label="Opportunities"
                stickyFirst={!compact}
                className="hidden rounded-md ring-1 ring-inset ring-line md:block [&_table]:min-w-full"
                style={{ maxHeight: compact ? "calc(100dvh - 220px)" : undefined }}
              >
                <THead sticky>
                  <tr>
                    {cols.map((c) => (
                      <TH
                        key={c.key}
                        align={c.align}
                        className={cn(TIER_CLASS[c.tier], c.className)}
                        title={c.title}
                        aria-sort={filters.sort === c.sort ? (filters.dir === "asc" ? "ascending" : "descending") : undefined}
                      >
                        {c.sort ? (
                          <Link href={sortHref(c.sort)} scroll={false} className={cn("focus-inset inline-flex items-center gap-1 rounded-xs hover:text-fg-2", filters.sort === c.sort && "text-fg")}>
                            {c.label}
                            {filters.sort === c.sort ? filters.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
                          </Link>
                        ) : (
                          c.label
                        )}
                      </TH>
                    ))}
                  </tr>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <RadarTableRow key={r.id} r={r} cols={cols} compact={compact} selected={r.id === (pendingSel ?? sel)} onSelect={selectRow} href={hrefWith({ sel: r.id })} nowMs={nowMs} sample={isSample(r.createdAt, sampleBefore)} />
                  ))}
                </TBody>
              </DataTable>
              <ul className="divide-y divide-line rounded-md ring-1 ring-inset ring-line md:hidden" aria-label="Opportunities">
                {rows.map((r) => (
                  <RadarListRow key={r.id} r={r} selected={r.id === (pendingSel ?? sel)} onSelect={selectRow} href={hrefWith({ sel: r.id })} nowMs={nowMs} sample={isSample(r.createdAt, sampleBefore)} />
                ))}
              </ul>
            </>
          )}
        </div>

        {sel ? (
          <>
            <button type="button" aria-label="Close details" className="fixed inset-0 z-30 bg-black/50 xl:hidden" onClick={() => navigate({ sel: undefined })} />
            <aside
              className="fixed inset-y-0 right-0 z-40 flex w-[min(100vw,600px)] flex-col border-l border-line-strong bg-bg-raised shadow-3 xl:sticky xl:inset-auto xl:top-5 xl:z-auto xl:h-[calc(100dvh-40px)] xl:w-auto xl:rounded-md xl:border xl:border-line xl:bg-bg xl:shadow-none"
              aria-label="Opportunity details"
            >
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
                <span className="eyebrow">Analysis</span>
                <span className="hidden items-center gap-1 text-[11px] text-fg-3 sm:flex">
                  <Kbd>esc</Kbd> close
                </span>
                <button type="button" onClick={() => navigate({ sel: undefined })} className="ml-auto grid size-7 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close details" data-testid="radar-pane-close">
                  <X className="size-4" />
                </button>
              </div>
              <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
                {paneLoading ? <PaneSkeleton /> : pane}
              </div>
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}

function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading analysis">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

function dlText(dl: number | null): string {
  if (dl === null) return "—";
  if (dl < 0) return "passed";
  if (dl < 1) return `${Math.max(1, Math.round(dl * 24))}h`;
  return `${Math.round(dl)}d`;
}

function ProfitValue({ r }: { r: RadarRow }) {
  if (r.recommendation === null) return <PendingCell />;
  return (
    <span className="inline-flex items-center gap-1">
      {r.estimateComplete === false ? (
        <span className="text-warn" title="Incomplete estimate — some line items are unpriced">
          ≈
        </span>
      ) : null}
      {formatUsd(r.expectedProfitUsd)}
    </span>
  );
}

function rowMeta(r: RadarRow): string {
  return [SOURCE_SHORT[r.sourceKey] ?? r.sourceKey, r.clientName, r.marketKey ? serviceFamilyLabel(r.marketKey, true) : r.marketName].filter(Boolean).join(" · ");
}

function RadarTableRow({ r, cols, compact, selected, onSelect, href, nowMs, sample }: { r: RadarRow; cols: Col[]; compact: boolean; selected: boolean; onSelect: (id: string) => void; href: string; nowMs: number; sample: boolean }) {
  const st = OPPORTUNITY_META[r.status as OpportunityState];
  const ageH = (nowMs - new Date(r.postedAt ?? r.createdAt).getTime()) / 3_600_000;
  const dl = r.deadlineAt ? (new Date(r.deadlineAt).getTime() - nowMs) / 86_400_000 : null;
  const pending = r.recommendation === null;
  const cell = (c: Col): ReactNode => {
    const tier = TIER_CLASS[c.tier];
    switch (c.key) {
      case "source":
        return <TD key={c.key} className={cn(tier, "font-mono text-[11px] uppercase tracking-[0.05em] text-fg-3")}>{SOURCE_SHORT[r.sourceKey] ?? r.sourceKey}</TD>;
      case "title":
        return (
          <TD key={c.key} className={cn("whitespace-normal py-1.5", compact ? "min-w-[200px] max-w-[280px]" : "max-w-[380px]", selected ? "bg-surface-2" : "group-hover/row:bg-surface-1")}>
            <Link
              href={href}
              scroll={false}
              onClick={(e) => {
                e.preventDefault();
                onSelect(r.id);
              }}
              className="focus-inset line-clamp-2 rounded-xs font-medium leading-5 text-fg"
              title={r.title}
            >
              {r.title}
            </Link>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-fg-3">
              <span className="truncate">
                {rowMeta(r)}
                {compact ? ` · ${fmtBudget(r.budgetType, r.budgetMinUsd, r.budgetMaxUsd)}` : ""}
              </span>
              {sample ? <SampleBadge className="h-4" /> : null}
            </span>
          </TD>
        );
      case "profit":
        return (
          <TD key={c.key} num className={cn(tier, r.expectedProfitUsd !== null && r.expectedProfitUsd < 0 ? "text-risk" : "text-fg")}>
            <ProfitValue r={r} />
          </TD>
        );
      case "margin":
        return (
          <TD key={c.key} num className={cn(tier, r.expectedMargin !== null && r.expectedMargin < 0.5 ? "text-fg-3" : "text-fg")}>
            {pending ? <PendingCell /> : formatPct(r.expectedMargin)}
          </TD>
        );
      case "rec":
        return (
          <TD key={c.key} className={tier}>
            <RecChip rec={r.recommendation} pending={r.status === "analysing" ? "analysing" : "queued"} />
          </TD>
        );
      case "budget":
        return <TD key={c.key} num className={tier}>{fmtBudget(r.budgetType, r.budgetMinUsd, r.budgetMaxUsd)}</TD>;
      case "cost":
        return <TD key={c.key} num className={cn(tier, "text-fg-2")}>{pending ? <PendingCell /> : formatUsd(r.estimatedCostUsd)}</TD>;
      case "fees":
        return <TD key={c.key} num className={cn(tier, "text-fg-2")}>{pending ? <PendingCell /> : formatUsd(r.expectedFeesUsd)}</TD>;
      case "deadline":
        return <TD key={c.key} num className={cn(tier, dl !== null && dl < 2 ? "text-warn" : "text-fg-2")}>{dlText(dl)}</TD>;
      case "age":
        return <TD key={c.key} num className={cn(tier, "text-fg-2")}>{fmtAge(ageH)}</TD>;
      case "fit":
        return <TD key={c.key} align="right" className={tier}><MiniMeter value={r.fit} /></TD>;
      case "complexity":
        return <TD key={c.key} align="right" className={tier}><MiniMeter value={r.complexity} invert /></TD>;
      case "rrisk":
        return <TD key={c.key} align="right" className={tier}><MiniMeter value={r.revisionRisk} invert /></TD>;
      case "drisk":
        return <TD key={c.key} align="right" className={tier}><MiniMeter value={r.deadlineRisk} invert /></TD>;
      case "confidence":
        return <TD key={c.key} align="right" className={tier}><MiniMeter value={r.confidence} /></TD>;
      case "status":
        return (
          <TD key={c.key} className={tier}>
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
              <StatusDot tone={st.tone} live={st.live} />
              {st.label}
            </span>
          </TD>
        );
      default:
        return null;
    }
  };
  return (
    <TR
      interactive
      selected={selected}
      className="[&>td]:h-12"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        onSelect(r.id);
      }}
      data-testid="radar-row"
      data-opportunity-id={r.id}
      data-recommendation={r.recommendation ?? "pending"}
      data-status={r.status}
    >
      {cols.map(cell)}
    </TR>
  );
}

/** Below md: stacked row — title + meta left; profit, margin and recommendation right. */
function RadarListRow({ r, selected, onSelect, href, nowMs, sample }: { r: RadarRow; selected: boolean; onSelect: (id: string) => void; href: string; nowMs: number; sample: boolean }) {
  const ageH = (nowMs - new Date(r.postedAt ?? r.createdAt).getTime()) / 3_600_000;
  const pending = r.recommendation === null;
  return (
    <li
      className={cn("relative flex gap-3 px-3.5 py-3", selected ? "bg-surface-2" : "active:bg-surface-1")}
      data-testid="radar-row"
      data-opportunity-id={r.id}
      data-recommendation={r.recommendation ?? "pending"}
      data-status={r.status}
    >
      <div className="min-w-0 flex-1">
        <Link
          href={href}
          scroll={false}
          onClick={(e) => {
            e.preventDefault();
            onSelect(r.id);
          }}
          className="line-clamp-2 text-[13px] font-medium leading-5 text-fg outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
        >
          {r.title}
        </Link>
        <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-fg-3">
          {rowMeta(r)} · {fmtBudget(r.budgetType, r.budgetMinUsd, r.budgetMaxUsd)} · {fmtAge(ageH)}
        </p>
        {sample ? <SampleBadge className="mt-1 h-4" /> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={cn("font-mono text-[13px] tabular", r.expectedProfitUsd !== null && r.expectedProfitUsd < 0 ? "text-risk" : "text-fg")}>
          <ProfitValue r={r} />
        </span>
        <span className="font-mono text-[11px] tabular text-fg-3">{pending ? "—" : `${formatPct(r.expectedMargin)} margin`}</span>
        <RecChip rec={r.recommendation} pending={r.status === "analysing" ? "analysing" : "queued"} size="sm" />
      </div>
    </li>
  );
}

function PendingCell() {
  return <span className="inline-block h-2 w-8 rounded-full bg-surface-2" role="img" aria-label="pending analysis" />;
}

function AdvancedFilters({ filters, onApply, activeCount }: { filters: RadarFilters; onApply: (p: Record<string, string | undefined>) => void; activeCount: number }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    bmin: filters.bmin?.toString() ?? "",
    bmax: filters.bmax?.toString() ?? "",
    pmin: filters.pmin?.toString() ?? "",
    mmin: filters.mmin?.toString() ?? "",
    cmin: filters.cmin?.toString() ?? "",
    risk: filters.risk ?? "",
    age: filters.age?.toString() ?? "",
  });
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed the form from the URL each time it opens
    setV({
      bmin: filters.bmin?.toString() ?? "",
      bmax: filters.bmax?.toString() ?? "",
      pmin: filters.pmin?.toString() ?? "",
      mmin: filters.mmin?.toString() ?? "",
      cmin: filters.cmin?.toString() ?? "",
      risk: filters.risk ?? "",
      age: filters.age?.toString() ?? "",
    });
  }, [open, filters]);
  const apply = () => {
    onApply({ bmin: v.bmin || undefined, bmax: v.bmax || undefined, pmin: v.pmin || undefined, mmin: v.mmin || undefined, cmin: v.cmin || undefined, risk: v.risk || undefined, age: v.age || undefined });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" data-testid="radar-more-filters">
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
          Filters
          {activeCount ? <span className="rounded-[3px] bg-surface-3 px-1 font-mono text-[10.5px] text-fg">{activeCount}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px]" align="start">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
          className="grid grid-cols-2 gap-3"
        >
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Budget min
            <Input type="number" min={0} prefix="$" value={v.bmin} onChange={(e) => setV({ ...v, bmin: e.target.value })} inputSize="sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Budget max
            <Input type="number" min={0} prefix="$" value={v.bmax} onChange={(e) => setV({ ...v, bmax: e.target.value })} inputSize="sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Expected profit ≥
            <Input type="number" min={0} prefix="$" value={v.pmin} onChange={(e) => setV({ ...v, pmin: e.target.value })} inputSize="sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Margin ≥
            <Input type="number" min={0} max={100} suffix="%" value={v.mmin} onChange={(e) => setV({ ...v, mmin: e.target.value })} inputSize="sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Confidence ≥
            <Input type="number" min={0} max={100} suffix="%" value={v.cmin} onChange={(e) => setV({ ...v, cmin: e.target.value })} inputSize="sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Risk
            <Select selectSize="sm" value={v.risk} onChange={(e) => setV({ ...v, risk: e.target.value })}>
              <option value="">Any</option>
              <option value="medium">≤ Medium</option>
              <option value="low">Low only</option>
            </Select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-xs text-fg-2">
            Age
            <Select selectSize="sm" value={v.age} onChange={(e) => setV({ ...v, age: e.target.value })}>
              <option value="">Any age</option>
              <option value="6">Last 6 hours</option>
              <option value="24">Last 24 hours</option>
              <option value="48">Last 2 days</option>
              <option value="96">Last 4 days</option>
              <option value="168">Last 7 days</option>
            </Select>
          </label>
          <div className="col-span-2 flex justify-end gap-2 border-t border-line pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setV({ bmin: "", bmax: "", pmin: "", mmin: "", cmin: "", risk: "", age: "" })}>
              Reset
            </Button>
            <Button type="submit" variant="secondary" size="sm">
              Apply filters
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
