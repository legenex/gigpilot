"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button, Callout, cn, useToast } from "@gigpilot/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RelTime } from "@/components/rel-time";
import { rotateInboundSecretAction } from "@/lib/actions/integrations";
import { useAction } from "@/lib/use-action";

/** 32 random bytes from the browser CSPRNG → "gpwh_<64 hex>". Never generated or echoed by the server. */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `gpwh_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="grid size-7 shrink-0 place-items-center rounded-xs text-fg-3 ring-1 ring-inset ring-line hover:bg-surface-3 hover:text-fg"
      aria-label={label}
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => toast({ title: "Copy failed — select the text and copy it manually.", tone: "error" }),
        );
      }}
    >
      {copied ? <Check className="size-3.5 text-profit" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * Per-workspace inbound webhook secret + signing scheme (security review M3).
 * The generated secret is shown exactly once; afterwards only its hint.
 */
export function InboundWebhookPanel({
  secret,
  appUrl,
  slug,
  canManage,
}: {
  secret: { hint: string; updatedAt: string } | null;
  appUrl: string;
  slug: string;
  canManage: boolean;
}) {
  const { run, pending } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const endpoint = `${appUrl.replace(/\/$/, "")}/api/inbound/<provider>?tenant=${slug}`;
  const example = [
    `# provider: contra | fiverr | upwork | generic`,
    `BODY='{"subject":"New opportunity: 30s product video","text":"Budget: $800 ..."}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s' "$TS.${slug}.contra.$BODY" | openssl dgst -sha256 -hmac "$GIGPILOT_INBOUND_SECRET" -hex | sed 's/^.* //')`,
    `curl -sS -X POST "${appUrl.replace(/\/$/, "")}/api/inbound/contra?tenant=${slug}" \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "x-gigpilot-timestamp: $TS" \\`,
    `  -H "x-gigpilot-signature: $SIG" \\`,
    `  --data-binary "$BODY"`,
  ].join("\n");

  const doRotate = () => {
    const value = generateSecret();
    run(() => rotateInboundSecretAction(value), {
      success: false,
      onSuccess: () => {
        setConfirm(false);
        setRevealed(value);
      },
      onError: () => setConfirm(false),
    });
  };

  return (
    <section aria-labelledby="inbound-webhook-title" className="rounded-md bg-surface-1/50 ring-1 ring-inset ring-line" data-testid="inbound-webhook-panel">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <h3 id="inbound-webhook-title" className="flex items-center gap-2 text-[14px] font-semibold text-fg">
          <KeyRound className="size-4 text-fg-3" strokeWidth={1.75} />
          Inbound webhook
        </h3>
        <span className={cn("font-mono text-[11px]", secret ? "text-profit" : "text-warn")} data-testid="inbound-secret-status">
          {secret ? (
            <>
              secret <span data-testid="inbound-secret-hint">{secret.hint}</span> · rotated <RelTime date={secret.updatedAt} />
            </>
          ) : (
            "no secret yet — forwarded emails are rejected"
          )}
        </span>
        {canManage ? (
          <Button
            size="xs"
            variant={secret ? "outline" : "secondary"}
            className="ml-auto"
            loading={pending}
            onClick={() => (secret ? setConfirm(true) : doRotate())}
            data-testid="inbound-secret-generate"
          >
            <RefreshCw className="size-3" /> {secret ? "Rotate secret" : "Generate secret"}
          </Button>
        ) : (
          <span className="ml-auto text-[11px] text-fg-3">Owners and admins manage the secret.</span>
        )}
      </header>

      <div className="flex flex-col gap-3 px-4 py-3.5 text-xs leading-5 text-fg-2">
        {revealed ? (
          <Callout tone="warn" icon={<TriangleAlert />} title="Copy this secret now — it is shown only once">
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-xs bg-surface-2 px-2 py-1.5 font-mono text-[11.5px] text-fg" data-testid="inbound-secret-value">
                {revealed}
              </code>
              <CopyButton value={revealed} label="Copy inbound secret" testId="inbound-secret-copy" />
            </div>
            <p className="mt-2 text-[11.5px] text-fg-3">
              Store it in your email→webhook relay as <code className="font-mono">GIGPILOT_INBOUND_SECRET</code>. GigPilot keeps it encrypted and will only ever show the last 4 characters. Rotating replaces it immediately.
            </p>
            <Button size="xs" variant="ghost" className="mt-2" onClick={() => setRevealed(null)} data-testid="inbound-secret-dismiss">
              I’ve stored it
            </Button>
          </Callout>
        ) : null}

        <p className="flex gap-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
          <span>
            Forward your own Contra, Fiverr or Upwork notification emails through an email→webhook relay. Every request must be signed with this workspace’s secret; unsigned, stale (&gt; 5 min) or replayed requests are rejected with the same <code className="font-mono">401</code>.
          </span>
        </p>

        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[150px_minmax(0,1fr)]">
          <dt className="text-fg-3">Endpoint</dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-fg-2">POST {endpoint}</dd>
          <dt className="text-fg-3">x-gigpilot-timestamp</dt>
          <dd className="font-mono text-[11px] text-fg-2">unix seconds (±300 s of server time)</dd>
          <dt className="text-fg-3">x-gigpilot-signature</dt>
          <dd className="min-w-0 break-words font-mono text-[11px] text-fg-2">hex(HMAC-SHA256(secret, &quot;timestamp.{slug}.provider.rawBody&quot;))</dd>
          <dt className="text-fg-3">Body</dt>
          <dd className="font-mono text-[11px] text-fg-2">JSON {"{ subject, text | html, from?, receivedAt?, messageId? }"} or raw text · ≤ 1 MB</dd>
        </dl>

        <div className="rounded-sm bg-surface-2 ring-1 ring-inset ring-line">
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3">Example (placeholders — never paste the secret into shared scripts)</span>
            <CopyButton value={example} label="Copy curl example" testId="inbound-curl-copy" />
          </div>
          <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-[17px] text-fg-2" data-testid="inbound-curl-example">
            {example}
          </pre>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Rotate the inbound secret?"
        description="The current secret stops working immediately. Update your email relay with the new secret right after rotating."
        confirmLabel="Rotate secret"
        tone="danger"
        loading={pending}
        onConfirm={doRotate}
      />
    </section>
  );
}
