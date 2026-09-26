"use client";

import { useState } from "react";
import { ArrowUpRight, Box, Check, ChevronDown, ClipboardPaste, Copy, KeyRound, PlugZap, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge, Button, Input, StatusDot, Switch, Tooltip, cn, useToast } from "@gigpilot/ui";
import { RelTime } from "@/components/rel-time";
import { useShell } from "@/components/shell/app-shell";
import type { ManualSourceKey } from "@/components/shell/paste-dialog";
import { clearSecretAction, refreshSourceAction, saveSecretAction, setProviderEnabledAction, setSourceEnabledAction, testConnectionAction } from "@/lib/actions/integrations";
import { INTEGRATION_STATUS_META } from "@/lib/labels";
import type { IntegrationView } from "@/lib/queries/integrations";
import { useAction } from "@/lib/use-action";

const MANUAL: Record<string, ManualSourceKey> = { upwork: "upwork", freelancer: "freelancer", contra: "contra", fiverr: "fiverr", direct: "direct", web: "web" };
const INBOUND = new Set(["contra", "fiverr", "upwork"]);

function Cap({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <li className="flex items-center gap-1.5 text-[11.5px]" title={hint}>
      {ok === null ? <span className="size-3" /> : ok ? <Check className="size-3 text-profit" strokeWidth={2.25} aria-label="yes" /> : <X className="size-3 text-fg-3" strokeWidth={2.25} aria-label="no" />}
      <span className={ok ? "text-fg-2" : "text-fg-3"}>{label}</span>
    </li>
  );
}

export function IntegrationCard({ it, webhookUrl, inboundSecretSet, paidEnabled }: { it: IntegrationView; webhookUrl: string | null; inboundSecretSet: boolean; paidEnabled: boolean }) {
  const { run, pending } = useAction();
  const { toast } = useToast();
  const { openPaste } = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [credsOpen, setCredsOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const baseMeta = INTEGRATION_STATUS_META[it.status] ?? INTEGRATION_STATUS_META.needs_configuration!;
  const meta = it.sandboxRequired ? { ...baseMeta, label: "Sandbox required", tone: "warn" as const } : baseMeta;
  const caps = it.capabilities;
  const withBusy = (_key: string) => ({ onSuccess: () => setBusy(null), onError: () => setBusy(null) });
  const storedCount = it.secretFields.filter((f) => f.hint).length;

  const test = () => {
    setBusy("test");
    run(() => testConnectionAction(it.key), {
      success: false,
      onSuccess: (h) => {
        setBusy(null);
        const r = h as { status: string; detail: string; latencyMs: number } | undefined;
        if (r) toast({ title: `${it.name}: ${INTEGRATION_STATUS_META[r.status]?.label ?? r.status}`, description: `${r.detail}${r.latencyMs ? ` · ${r.latencyMs}ms` : ""}`, tone: r.status === "connected" || r.status === "mock" ? "success" : r.status === "error" ? "error" : "info" });
      },
      onError: () => setBusy(null),
    });
  };

  return (
    <article className="flex flex-col rounded-md bg-surface-1/50 ring-1 ring-inset ring-line" data-testid="integration-card" data-key={it.key} data-status={it.status} aria-labelledby={`int-${it.key}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <span className={cn("flex items-center gap-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em]", meta.tone === "profit" ? "text-profit" : meta.tone === "warn" ? "text-warn" : meta.tone === "risk" ? "text-risk" : meta.tone === "info" ? "text-info" : "text-fg-3")}>
          <StatusDot tone={meta.tone} />
          {meta.label}
        </span>
        <span className="font-mono text-[10.5px] text-fg-3">
          {it.latencyMs ? `${it.latencyMs}ms · ` : ""}
          {it.isSource ? (it.lastSyncAt ? <>synced <RelTime date={it.lastSyncAt} /></> : "never synced") : it.checkedAt ? <>checked <RelTime date={it.checkedAt} /></> : "not checked"}
        </span>
        <Button size="xs" variant="outline" className="ml-auto" loading={pending && busy === "test"} onClick={test} data-testid="integration-test">
          <PlugZap className="size-3" /> Test connection
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id={`int-${it.key}`} className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
              {it.name}
              {it.paid ? (
                <Tooltip content={paidEnabled ? "Paid provider — calls bill real money within your daily limit." : "Paid provider — stays in mock/test mode until both the server budget and your daily paid limit are above $0."}>
                  <Badge mono tone={paidEnabled ? "warn" : "neutral"} className="h-[18px] text-[9.5px]">
                    {paidEnabled ? "paid" : "paid · off"}
                  </Badge>
                </Tooltip>
              ) : (
                <Badge mono className="h-[18px] text-[9.5px]">
                  free
                </Badge>
              )}
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-fg-3">{it.description}</p>
          </div>
          {it.isSource ? (
            <Switch checked={it.enabled} disabled={pending && busy === "toggle"} onCheckedChange={(v) => { setBusy("toggle"); run(() => setSourceEnabledAction(it.key, v), withBusy("toggle")); }} label={`${it.enabled ? "Disable" : "Enable"} ${it.name} source`} testId={`source-toggle-${it.key}`} />
          ) : it.kind !== "orchestration" ? (
            <Switch checked={it.enabled} disabled={pending && busy === "toggle"} onCheckedChange={(v) => { setBusy("toggle"); run(() => setProviderEnabledAction(it.key, v), withBusy("toggle")); }} label={`${it.enabled ? "Disable" : "Enable"} ${it.name}`} />
          ) : null}
        </div>

        {it.sandboxRequired ? (
          <div className="flex gap-2.5 rounded-sm bg-warn/[0.07] px-2.5 py-2 ring-1 ring-inset ring-warn/25" data-testid="factory-sandbox-required">
            <Box className="mt-0.5 size-3.5 shrink-0 text-warn" strokeWidth={1.75} aria-hidden />
            <div className="text-[11.5px] leading-[17px] text-fg-2">
              <p className="font-medium text-fg">Requires an isolated sandbox runner</p>
              <p className="mt-0.5 text-fg-3">
                Factory’s <code className="font-mono">droid exec</code> would run inside the worker and could read its environment and mounted secrets, so it stays off. Reasoning routes to GX and Grok meanwhile. An operator can enable it with{" "}
                <code className="font-mono">FACTORY_ALLOW_IN_PROCESS=true</code> only on a secret-free sandbox worker.
              </p>
            </div>
          </div>
        ) : it.statusDetail || it.lastError ? (
          <p className={cn("rounded-sm px-2.5 py-1.5 font-mono text-[11px] leading-4", it.status === "error" ? "bg-risk-wash text-risk" : "bg-surface-2 text-fg-2")}>{it.lastError ?? it.statusDetail}</p>
        ) : null}

        {caps ? (
          <>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
              {(
                [
                  { ok: caps.canSearch, label: caps.backgroundPollingAllowed ? "Automated search" : caps.canSearch ? "User-directed search" : "No search API" },
                  { ok: caps.canSubmit, label: caps.canSubmit ? "Submits after approval" : "Manual submission" },
                  { ok: caps.backgroundPollingAllowed, label: caps.backgroundPollingAllowed ? `Polls ≥ ${caps.minPollIntervalMinutes}m` : "No background polling" },
                  caps.maxCacheTtlHours !== null ? { ok: true, label: `Cache ≤ ${caps.maxCacheTtlHours}h` } : null,
                  caps.requiresUserOAuth ? { ok: true, label: "Your OAuth token" } : null,
                  { ok: null, label: `${caps.ingestionMode} intake` },
                ].filter(Boolean) as { ok: boolean | null; label: string }[]
              ).map((c) => (
                <Cap key={c.label} ok={c.ok} label={c.label} />
              ))}
            </ul>
            <p className="flex gap-2 text-xs leading-5 text-fg-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
              <span>{caps.compliance}</span>
            </p>
          </>
        ) : null}

        {INBOUND.has(it.key) && webhookUrl ? (
          <div className="rounded-sm bg-surface-2 px-2.5 py-2 text-[11px]">
            <p className="mb-1 flex items-center justify-between text-fg-3">
              <span>Forward notification emails to (via an email→webhook relay)</span>
              <span className={inboundSecretSet ? "text-profit" : "text-warn"}>{inboundSecretSet ? "workspace secret set" : "generate the inbound secret above"}</span>
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-fg-2">POST {webhookUrl}</code>
              <button
                type="button"
                className="grid size-6 place-items-center rounded-xs text-fg-3 hover:bg-surface-3 hover:text-fg"
                aria-label="Copy webhook URL"
                onClick={() => {
                  void navigator.clipboard?.writeText(webhookUrl);
                  toast({ title: "Webhook URL copied", tone: "success" });
                }}
              >
                <Copy className="size-3" />
              </button>
            </div>
            <p className="mt-1 text-fg-3">Signed with this workspace’s secret — see “Inbound webhook” above for headers and a curl example.</p>
          </div>
        ) : null}

        {it.envVars.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">env</span>
            {it.envVars.map((v) => (
              <code key={v} className="rounded-[3px] bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2 ring-1 ring-inset ring-line">
                {v}
              </code>
            ))}
          </div>
        ) : null}

        {it.secretFields.length ? (
          <div className="rounded-sm ring-1 ring-inset ring-line">
            <button type="button" onClick={() => setCredsOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs text-fg-2 hover:text-fg" aria-expanded={credsOpen}>
              <KeyRound className="size-3.5 text-fg-3" strokeWidth={1.75} />
              Workspace credentials
              <span className="font-mono text-[11px] text-fg-3">
                {storedCount}/{it.secretFields.length} stored · encrypted, write-only
              </span>
              <ChevronDown className={cn("ml-auto size-3.5 text-fg-3 transition-transform", credsOpen && "rotate-180")} />
            </button>
            {credsOpen ? (
              <div className="flex flex-col gap-2.5 border-t border-line px-2.5 py-2.5">
                {it.secretFields.map((f) => (
                  <form
                    key={f.name}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = values[f.name]?.trim() ?? "";
                      if (v.length < 8) {
                        toast({ title: "Credential looks too short (min 8 characters).", tone: "error" });
                        return;
                      }
                      setBusy(`save-${f.name}`);
                      run(() => saveSecretAction(it.key, f.name, v), {
                        onSuccess: () => {
                          setBusy(null);
                          setValues((x) => ({ ...x, [f.name]: "" }));
                        },
                        onError: () => setBusy(null),
                      });
                    }}
                  >
                    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-fg-3">
                      <span className="flex items-center gap-2">
                        {f.label} <code className="font-mono text-[10px]">{f.name}</code>
                        {f.hint ? <span className="ml-auto font-mono text-fg-2">{f.hint}</span> : <span className="ml-auto">not stored</span>}
                      </span>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        inputSize="sm"
                        placeholder={f.hint ? "Enter a new value to replace" : "Paste value"}
                        value={values[f.name] ?? ""}
                        onChange={(e) => setValues((x) => ({ ...x, [f.name]: e.target.value }))}
                        aria-label={`${it.name} ${f.label}`}
                      />
                    </label>
                    <span className="flex gap-1">
                      <Button type="submit" size="sm" variant="secondary" loading={pending && busy === `save-${f.name}`} disabled={!values[f.name]}>
                        Save
                      </Button>
                      {f.hint ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${f.label}`}
                          loading={pending && busy === `clear-${f.name}`}
                          onClick={() => {
                            setBusy(`clear-${f.name}`);
                            run(() => clearSecretAction(it.key, f.name), withBusy(`clear-${f.name}`));
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </span>
                  </form>
                ))}
                <p className="text-[11px] leading-4 text-fg-3">
                  Stored values are AES-256-GCM encrypted and never shown again — only the last 4 characters. {it.key === "gx" ? "Without a workspace key the shared local GX gateway is used (quota-limited)." : "Workspaces use their own credentials; server-wide keys are reserved for the operator’s workspace."}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {it.isSource || it.docsUrl ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          {it.isSource && it.key !== "direct" ? (
            <Button
              size="xs"
              variant="secondary"
              disabled={!it.enabled}
              title={it.enabled ? undefined : "Enable the source first"}
              loading={pending && busy === "refresh"}
              onClick={() => {
                setBusy("refresh");
                run(() => refreshSourceAction(it.key), withBusy("refresh"));
              }}
              data-testid={`source-refresh-${it.key}`}
            >
              <RefreshCw className="size-3" /> Refresh now
            </Button>
          ) : null}
          {MANUAL[it.key] ? (
            <Button size="xs" variant="ghost" onClick={() => openPaste(MANUAL[it.key])} data-testid={`paste-${it.key}`}>
              <ClipboardPaste className="size-3" /> Paste an opportunity
            </Button>
          ) : null}
          {it.docsUrl ? (
            <a href={it.docsUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-fg-3 hover:text-fg">
              Official docs <ArrowUpRight className="size-3" />
            </a>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
