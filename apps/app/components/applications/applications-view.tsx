"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Columns3, MessageSquare, MoreHorizontal, Rows3, Send, Trophy, X } from "lucide-react";
import { APPLICATION_STATES, type ApplicationState } from "@gigpilot/contracts";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SegmentedControl,
  StatusDot,
  TBody,
  TD,
  TH,
  THead,
  TR,
  cn,
  formatUsd,
} from "@gigpilot/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RelTime } from "@/components/rel-time";
import { markSubmittedAction, recordOutcomeAction } from "@/lib/actions/applications";
import { APPLICATION_META, SOURCE_SHORT } from "@/lib/labels";
import type { ApplicationRow, PendingProposal } from "@/lib/queries/applications";
import { useAction } from "@/lib/use-action";

type Outcome = "client_response" | "negotiating" | "won" | "lost";

const OUTCOMES_FROM: Partial<Record<ApplicationState, Outcome[]>> = {
  submitted: ["client_response", "won", "lost"],
  client_response: ["negotiating", "won", "lost"],
  negotiating: ["client_response", "won", "lost"],
};

const MODE_LABEL = { api: "API", manual: "Manual", mock: "Demo" } as const;

export function ApplicationsView({
  apps,
  pending,
  counts,
  view,
  stateFilter,
}: {
  apps: ApplicationRow[];
  pending: PendingProposal[];
  counts: Record<ApplicationState, number>;
  view: "board" | "table";
  stateFilter: ApplicationState | null;
}) {
  const [submitFor, setSubmitFor] = useState<ApplicationRow | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<{ app: ApplicationRow; outcome: Outcome } | null>(null);
  const [ref, setRef] = useState("");
  const { run, pending: busy } = useAction();

  const openOutcome = (app: ApplicationRow, outcome: Outcome) => setOutcomeFor({ app, outcome });
  const total = apps.length + pending.length;
  const filtered = stateFilter ? apps.filter((a) => a.status === stateFilter) : apps;

  const strip = (
    <nav aria-label="Pipeline stages" className="overflow-x-auto">
      <ol className="flex min-w-max gap-px overflow-hidden rounded-md bg-line ring-1 ring-inset ring-line">
        {APPLICATION_STATES.map((s, i) => {
          const m = APPLICATION_META[s];
          const active = stateFilter === s;
          return (
            <li key={s} className="flex-1">
              <Link
                href={active ? `?view=${view}` : `?view=${view}&state=${s}`}
                scroll={false}
                className={cn("flex h-full min-w-[118px] flex-col gap-0.5 bg-bg px-3 py-2 transition-colors hover:bg-surface-1", active && "bg-surface-2 hover:bg-surface-2")}
                aria-current={active ? "true" : undefined}
              >
                <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3">
                  <span className="font-mono text-[10px] text-fg-4">{String(i + 1).padStart(2, "0")}</span>
                  {m.label}
                </span>
                <span className={cn("text-[18px] font-semibold tracking-[-0.01em]", counts[s] ? "text-fg" : "text-fg-4")}>{counts[s]}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );

  const actions = (a: ApplicationRow, compact?: boolean) => {
    if (a.status === "approved" && a.submissionMode !== "api") {
      return (
        <Button size="xs" variant="secondary" onClick={() => { setRef(""); setSubmitFor(a); }} data-testid="application-mark-submitted">
          <Send className="size-3" /> Mark submitted
        </Button>
      );
    }
    const outs = OUTCOMES_FROM[a.status];
    if (outs) {
      return (
        <span className="flex items-center gap-1">
          <Button size="xs" variant="outline" onClick={() => openOutcome(a, "won")} data-testid="application-mark-won">
            <Trophy className="size-3" /> Won
          </Button>
          <Button size="xs" variant="ghost" onClick={() => openOutcome(a, "lost")} data-testid="application-mark-lost">
            <X className="size-3" /> Lost
          </Button>
          {!compact || outs.some((o) => o === "client_response" || o === "negotiating") ? (
            <Menu>
              <MenuTrigger className="grid size-6 place-items-center rounded-xs text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="More outcomes">
                <MoreHorizontal className="size-3.5" />
              </MenuTrigger>
              <MenuContent>
                {outs.includes("client_response") ? (
                  <MenuItem icon={<MessageSquare />} onSelect={() => openOutcome(a, "client_response")} testId="application-mark-response">
                    Client responded
                  </MenuItem>
                ) : null}
                {outs.includes("negotiating") ? (
                  <MenuItem icon={<MessageSquare />} onSelect={() => openOutcome(a, "negotiating")} testId="application-mark-negotiating">
                    Negotiating
                  </MenuItem>
                ) : null}
              </MenuContent>
            </Menu>
          ) : null}
        </span>
      );
    }
    if (a.jobId) {
      return (
        <Button size="xs" variant="ghost" asChild>
          <Link href={`/jobs/${a.jobId}`}>
            Open job <ArrowRight className="size-3" />
          </Link>
        </Button>
      );
    }
    if (a.status === "approved") return <span className="text-[11px] text-fg-3">Submitting via API…</span>;
    return null;
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="View"
          value={view}
          items={[
            { value: "board", label: "Board", icon: <Columns3 className="size-3.5" />, href: `?view=board${stateFilter ? `&state=${stateFilter}` : ""}` },
            { value: "table", label: "Table", icon: <Rows3 className="size-3.5" />, href: `?view=table${stateFilter ? `&state=${stateFilter}` : ""}` },
          ]}
        />
        <p className="ml-auto text-xs text-fg-3">{total} in pipeline · manual submissions are confirmed here after you submit on the marketplace</p>
      </div>
      {strip}

      {total === 0 ? (
        <EmptyState
          icon={<Send />}
          title="No applications yet"
          description="Approve pursuit on a Radar opportunity; once you approve the proposal it appears here for submission and outcome tracking."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/radar">Open Radar</Link>
            </Button>
          }
        />
      ) : view === "board" ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
          <div className="flex min-w-max gap-3">
            {APPLICATION_STATES.filter((s) => !stateFilter || s === stateFilter).map((s) => {
              const items = apps.filter((a) => a.status === s);
              const extra = s === "awaiting_approval" ? pending : [];
              const n = items.length + extra.length;
              const m = APPLICATION_META[s];
              if (n === 0 && !stateFilter) {
                return (
                  <div key={s} className="flex h-48 w-10 shrink-0 flex-col items-center gap-2 self-start rounded-md py-3 ring-1 ring-inset ring-line" aria-label={`${m.label}: empty`}>
                    <span className="font-mono text-[11px] text-fg-4">0</span>
                    <span className="text-[11px] text-fg-3 [writing-mode:vertical-rl]">{m.label}</span>
                  </div>
                );
              }
              return (
                <section key={s} className={cn("flex shrink-0 flex-col", ["won", "lost", "expired"].includes(s) ? "w-[232px]" : "w-[260px]")} aria-label={m.label}>
                  <header className="mb-2 flex items-center gap-2 px-1">
                    <StatusDot tone={m.tone} />
                    <h2 className="text-xs font-medium text-fg-2">{m.label}</h2>
                    <span className="font-mono text-[11px] text-fg-3">{n}</span>
                  </header>
                  <ul className="flex flex-col gap-2">
                    {extra.map((p) => (
                      <li key={p.id} className="rounded-md bg-surface-1 p-3 ring-1 ring-inset ring-accent-line">
                        <Link href={`/radar/${p.opportunityId}#proposal`} className="line-clamp-2 text-[13px] font-medium leading-5 text-fg hover:underline">
                          {p.title}
                        </Link>
                        <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-fg-3">
                          <span className="uppercase tracking-[0.05em]">{SOURCE_SHORT[p.sourceKey] ?? p.sourceKey}</span>
                          <span className="ml-auto text-[12px] tabular text-fg">{formatUsd(p.priceUsd)}</span>
                        </div>
                        <Button asChild size="xs" variant="outline" className="mt-2.5 w-full">
                          <Link href={`/radar/${p.opportunityId}#proposal`}>
                            <Check className="size-3" /> Review proposal
                          </Link>
                        </Button>
                      </li>
                    ))}
                    {items.map((a) =>
                      ["won", "lost", "expired"].includes(a.status) ? (
                        <li key={a.id} className="rounded-md px-3 py-2 ring-1 ring-inset ring-line" data-testid="application-row" data-application-id={a.id} data-status={a.status}>
                          <Link href={a.jobId ? `/jobs/${a.jobId}` : `/radar/${a.opportunityId}`} className="line-clamp-1 text-[13px] text-fg-2 hover:text-fg hover:underline">
                            {a.title}
                          </Link>
                          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-fg-3">
                            <span className="uppercase tracking-[0.05em]">{SOURCE_SHORT[a.sourceKey] ?? a.sourceKey}</span>
                            {a.jobId ? <span className="text-profit">job →</span> : null}
                            <span className="ml-auto tabular text-fg-2">{formatUsd(a.priceUsd)}</span>
                          </div>
                        </li>
                      ) : (
                      <li key={a.id} className="rounded-md bg-surface-1 p-3 ring-1 ring-inset ring-line" data-testid="application-row" data-application-id={a.id} data-status={a.status}>
                        <Link href={`/radar/${a.opportunityId}`} className="line-clamp-2 text-[13px] font-medium leading-5 text-fg hover:underline">
                          {a.title}
                        </Link>
                        <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-fg-3">
                          <span className="uppercase tracking-[0.05em]">{SOURCE_SHORT[a.sourceKey] ?? a.sourceKey}</span>
                          <Badge mono className="h-4 px-1 text-[9.5px]">
                            {MODE_LABEL[a.submissionMode]}
                          </Badge>
                          <span className="ml-auto text-[12px] tabular text-fg">{formatUsd(a.priceUsd)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-3">
                          <span className="truncate">{a.externalRef ?? (a.submittedAt ? "submitted" : "not submitted")}</span>
                          <RelTime date={a.updatedAt} className="ml-auto shrink-0 font-mono" />
                        </div>
                        {actions(a, true) ? <div className="mt-2.5 border-t border-line pt-2.5">{actions(a, true)}</div> : null}
                      </li>
                      ),
                    )}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <DataTable label="Applications" minWidth={960} className="rounded-md ring-1 ring-inset ring-line">
          <THead>
            <tr>
              <TH>Opportunity</TH>
              <TH>Client</TH>
              <TH align="right">Price</TH>
              <TH>Mode</TH>
              <TH>State</TH>
              <TH>Submitted</TH>
              <TH>External ref</TH>
              <TH align="right">Updated</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {filtered.map((a) => {
              const m = APPLICATION_META[a.status];
              return (
                <TR key={a.id} data-testid="application-row" data-application-id={a.id} data-status={a.status}>
                  <TD className="max-w-[340px]">
                    <Link href={`/radar/${a.opportunityId}`} className="block truncate font-medium text-fg hover:underline">
                      {a.title}
                    </Link>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-fg-3">{SOURCE_SHORT[a.sourceKey] ?? a.sourceKey}</span>
                  </TD>
                  <TD className="max-w-[160px] truncate text-fg-2">{a.clientName ?? "—"}</TD>
                  <TD num>{formatUsd(a.priceUsd)}</TD>
                  <TD>
                    <Badge mono>{MODE_LABEL[a.submissionMode]}</Badge>
                  </TD>
                  <TD>
                    <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
                      <StatusDot tone={m.tone} />
                      {m.label}
                    </span>
                  </TD>
                  <TD className="text-xs text-fg-3">{a.submittedAt ? <RelTime date={a.submittedAt} /> : "—"}</TD>
                  <TD className="max-w-[160px] truncate font-mono text-[11px] text-fg-3">{a.externalRef ?? "—"}</TD>
                  <TD align="right" className="text-xs text-fg-3">
                    <RelTime date={a.updatedAt} />
                  </TD>
                  <TD align="right">{actions(a)}</TD>
                </TR>
              );
            })}
          </TBody>
        </DataTable>
      )}

      <ConfirmDialog
        open={submitFor !== null}
        onOpenChange={(v) => !v && setSubmitFor(null)}
        title="Confirm manual submission"
        description={submitFor ? `Only confirm after you submitted the approved proposal on ${SOURCE_SHORT[submitFor.sourceKey] ?? submitFor.sourceKey}. GigPilot never submits on marketplaces that don't permit it.` : undefined}
        confirmLabel="Mark submitted"
        loading={busy}
        onConfirm={() => {
          if (!submitFor) return;
          run(() => markSubmittedAction(submitFor.id, ref), { onSuccess: () => setSubmitFor(null) });
        }}
      >
        <Field id="external-ref" label="Marketplace reference (optional)" hint="Proposal URL or ID, so replies can be matched later.">
          <Input id="external-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://www.upwork.com/ab/proposals/…" maxLength={300} data-testid="application-external-ref" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={outcomeFor !== null}
        onOpenChange={(v) => !v && setOutcomeFor(null)}
        title={outcomeFor?.outcome === "won" ? "Mark as won?" : outcomeFor?.outcome === "lost" ? "Mark as lost?" : outcomeFor?.outcome === "negotiating" ? "Mark as negotiating?" : "Record client response?"}
        description={
          outcomeFor?.outcome === "won"
            ? "Creates a job, sets its spend limit from your settings, and the Production Planner starts building the workflow."
            : outcomeFor?.outcome === "lost"
              ? "Closes the application. The outcome feeds market win-rate learning."
              : "Moves the application forward in the pipeline."
        }
        confirmLabel={outcomeFor?.outcome === "won" ? "Mark won & create job" : outcomeFor?.outcome === "lost" ? "Mark lost" : "Record"}
        tone={outcomeFor?.outcome === "lost" ? "danger" : outcomeFor?.outcome === "won" ? "primary" : "secondary"}
        loading={busy}
        onConfirm={() => {
          if (!outcomeFor) return;
          run(() => recordOutcomeAction(outcomeFor.app.id, outcomeFor.outcome), { onSuccess: () => setOutcomeFor(null) });
        }}
      >
        {outcomeFor ? (
          <p className="text-[13px] text-fg-2">
            {outcomeFor.app.title} · <span className="font-mono">{formatUsd(outcomeFor.app.priceUsd)}</span>
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
