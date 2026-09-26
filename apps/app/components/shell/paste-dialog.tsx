"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Callout, Dialog, DialogContent, Field, Input, Select, Textarea } from "@gigpilot/ui";
import { addManualOpportunityAction } from "@/lib/actions/opportunities";
import { useAction } from "@/lib/use-action";

export type ManualSourceKey = "upwork" | "freelancer" | "contra" | "fiverr" | "web" | "direct";

const SOURCES: { key: ManualSourceKey; label: string; note: string }[] = [
  { key: "upwork", label: "Upwork", note: "Paste a job you found while browsing Upwork yourself. GigPilot never scrapes Upwork; submission stays manual." },
  { key: "contra", label: "Contra", note: "Paste from a Contra notification or message you received." },
  { key: "fiverr", label: "Fiverr", note: "Paste a buyer brief from a Fiverr notification you received." },
  { key: "freelancer", label: "Freelancer", note: "Paste a Freelancer project. Bids are only placed after your approval." },
  { key: "direct", label: "Direct client", note: "A prospect or inbound lead you are talking to directly." },
  { key: "web", label: "Public web", note: "A public job post from a site that permits reuse. Keep the source link for attribution." },
];

export function PasteOpportunityDialog({ open, onOpenChange, source }: { open: boolean; onOpenChange: (v: boolean) => void; source?: ManualSourceKey }) {
  const id = useId();
  const router = useRouter();
  const { run, pending } = useAction();
  const [form, setForm] = useState({
    sourceKey: (source ?? "direct") as ManualSourceKey,
    title: "",
    description: "",
    url: "",
    clientName: "",
    budgetType: "fixed" as "fixed" | "hourly" | "unknown",
    budgetMinUsd: "",
    budgetMaxUsd: "",
    deadlineAt: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Adopt the requested source whenever the dialog (re)opens with one.
  const [seen, setSeen] = useState({ open, source });
  if (seen.open !== open || seen.source !== source) {
    setSeen({ open, source });
    if (open && source) setForm((f) => ({ ...f, sourceKey: source }));
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (form.title.trim().length < 4) e.title = "Add a title (at least 4 characters).";
    if (form.description.trim().length < 20) e.description = "Paste the full brief (at least 20 characters) so the analyst can price it.";
    if (form.url && !/^https?:\/\/\S+$/i.test(form.url.trim())) e.url = "Use a full http(s) link.";
    const min = form.budgetMinUsd ? Number(form.budgetMinUsd) : undefined;
    const max = form.budgetMaxUsd ? Number(form.budgetMaxUsd) : undefined;
    if (min !== undefined && (!Number.isFinite(min) || min < 0)) e.budgetMinUsd = "Enter a positive amount.";
    if (max !== undefined && (!Number.isFinite(max) || max < 0)) e.budgetMaxUsd = "Enter a positive amount.";
    if (min !== undefined && max !== undefined && max < min) e.budgetMaxUsd = "Max must be at least the min.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    run(
      () =>
        addManualOpportunityAction({
          sourceKey: form.sourceKey,
          title: form.title.trim(),
          description: form.description.trim(),
          url: form.url.trim() || undefined,
          clientName: form.clientName.trim() || undefined,
          budgetType: form.budgetType,
          budgetMinUsd: form.budgetMinUsd ? Number(form.budgetMinUsd) : undefined,
          budgetMaxUsd: form.budgetMaxUsd ? Number(form.budgetMaxUsd) : undefined,
          deadlineAt: form.deadlineAt || undefined,
        }),
      {
        onSuccess: (data) => {
          onOpenChange(false);
          setForm((f) => ({ ...f, title: "", description: "", url: "", clientName: "", budgetMinUsd: "", budgetMaxUsd: "", deadlineAt: "" }));
          const oppId = (data as { opportunityId?: string } | undefined)?.opportunityId;
          if (oppId) router.push(`/radar?sel=${oppId}`);
        },
      },
    );
  };

  const note = SOURCES.find((s) => s.key === form.sourceKey)?.note;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Paste an opportunity"
        description="Compliant manual intake. GigPilot analyses and prices it like any sourced opportunity."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={pending} data-testid="paste-submit">
              Add &amp; analyse
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field id={`${id}-source`} label="Source">
            <Select id={`${id}-source`} value={form.sourceKey} onChange={(e) => set("sourceKey", e.target.value as ManualSourceKey)}>
              {SOURCES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-client`} label="Client (optional)">
            <Input id={`${id}-client`} value={form.clientName} onChange={(e) => set("clientName", e.target.value)} placeholder="Acme Skincare" maxLength={200} />
          </Field>
          {note ? (
            <Callout tone="info" icon={<ShieldCheck />} className="sm:col-span-2">
              {note}
            </Callout>
          ) : null}
          <Field id={`${id}-title`} label="Title" error={errors.title} className="sm:col-span-2">
            <Input id={`${id}-title`} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="UGC video ads for a skincare launch (6 × 15s)" aria-invalid={!!errors.title} maxLength={300} data-testid="paste-title" />
          </Field>
          <Field id={`${id}-desc`} label="Brief" error={errors.description} hint="Paste the full description — deliverables, formats, deadline, assets." className="sm:col-span-2">
            <Textarea id={`${id}-desc`} rows={6} value={form.description} onChange={(e) => set("description", e.target.value)} aria-invalid={!!errors.description} maxLength={20000} data-testid="paste-description" />
          </Field>
          <Field id={`${id}-url`} label="Source link (optional)" error={errors.url} className="sm:col-span-2">
            <Input id={`${id}-url`} type="url" value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://" aria-invalid={!!errors.url} />
          </Field>
          <Field id={`${id}-btype`} label="Budget type">
            <Select id={`${id}-btype`} value={form.budgetType} onChange={(e) => set("budgetType", e.target.value as "fixed" | "hourly" | "unknown")}>
              <option value="fixed">Fixed price</option>
              <option value="hourly">Hourly</option>
              <option value="unknown">Unknown</option>
            </Select>
          </Field>
          <Field id={`${id}-deadline`} label="Deadline (optional)">
            <Input id={`${id}-deadline`} type="date" value={form.deadlineAt} onChange={(e) => set("deadlineAt", e.target.value)} />
          </Field>
          <Field id={`${id}-bmin`} label={form.budgetType === "hourly" ? "Rate min (USD/h)" : "Budget min (USD)"} error={errors.budgetMinUsd}>
            <Input id={`${id}-bmin`} type="number" inputMode="decimal" min={0} prefix="$" value={form.budgetMinUsd} onChange={(e) => set("budgetMinUsd", e.target.value)} aria-invalid={!!errors.budgetMinUsd} />
          </Field>
          <Field id={`${id}-bmax`} label={form.budgetType === "hourly" ? "Rate max (USD/h)" : "Budget max (USD)"} error={errors.budgetMaxUsd}>
            <Input id={`${id}-bmax`} type="number" inputMode="decimal" min={0} prefix="$" value={form.budgetMaxUsd} onChange={(e) => set("budgetMaxUsd", e.target.value)} aria-invalid={!!errors.budgetMaxUsd} />
          </Field>
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
