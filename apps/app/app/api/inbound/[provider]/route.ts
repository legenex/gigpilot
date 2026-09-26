import { CommandError, addManualOpportunity } from "@gigpilot/agents";
import { and, eq, getDb, sourceIntegration, tenant } from "@gigpilot/db";
import { parseInboundNotification, verifyInboundSignature, type InboundProvider } from "@gigpilot/providers";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROVIDERS: InboundProvider[] = ["contra", "fiverr", "upwork", "generic"];
const MAX_BYTES = 1_000_000;

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Forwarded marketplace notifications (owner's own emails via an
 * email→webhook relay). Verified with HMAC-SHA256 over the raw body
 * (x-gigpilot-signature, INBOUND_WEBHOOK_SECRET), tenant from ?tenant=<slug>.
 * The parsed opportunity goes through the same path as manual intake.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: p } = await params;
  const provider = p as InboundProvider;
  if (!PROVIDERS.includes(provider)) return json({ error: "unknown provider" }, 404);

  const url = new URL(request.url);
  const slug = (url.searchParams.get("tenant") ?? "").trim().slice(0, 80);
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`inbound:${ip}:${slug}`, 30, 60_000).ok) return json({ error: "rate limited" }, 429);

  const secret = process.env.INBOUND_WEBHOOK_SECRET?.trim();
  if (!secret) return json({ error: "inbound webhook not configured" }, 503);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return json({ error: "payload too large" }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return json({ error: "payload too large" }, 413);
  if (!verifyInboundSignature(raw, request.headers.get("x-gigpilot-signature"), secret)) return json({ error: "invalid signature" }, 401);

  if (!slug) return json({ error: "missing tenant" }, 400);
  const [t] = await getDb().select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, slug)).limit(1);
  if (!t) return json({ error: "unknown tenant" }, 404);

  let payload: { subject?: string; text?: string; html?: string; from?: string; receivedAt?: string } = {};
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
  } else {
    payload = { text: raw };
  }

  const sourceKey = provider === "generic" ? "direct" : provider;
  const [src] = await getDb()
    .select({ enabled: sourceIntegration.enabled })
    .from(sourceIntegration)
    .where(and(eq(sourceIntegration.tenantId, t.id), eq(sourceIntegration.sourceKey, sourceKey)))
    .limit(1);
  if (src && !src.enabled) return json({ ignored: true, reason: "source disabled in Integrations" }, 202);

  const parsed = parseInboundNotification({
    provider,
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
    text: typeof payload.text === "string" ? payload.text : undefined,
    html: typeof payload.html === "string" ? payload.html : undefined,
    from: typeof payload.from === "string" ? payload.from : undefined,
    receivedAt: typeof payload.receivedAt === "string" ? payload.receivedAt : undefined,
  });
  if (!parsed) return json({ ignored: true, reason: "not an opportunity" }, 202);

  try {
    // System actor for inbound intake (no user session). See report: a
    // dedicated ingestInboundOpportunity command would keep the email metadata.
    const res = await addManualOpportunity(
      { tenantId: t.id, userId: `inbound:${provider}`, role: "owner" },
      {
        sourceKey: sourceKey as "contra" | "fiverr" | "upwork" | "direct",
        title: parsed.title.length >= 4 ? parsed.title : `${parsed.title} (forwarded)`,
        description: parsed.description.length >= 20 ? parsed.description : `${parsed.description}\n\n(Forwarded ${provider} notification)`,
        url: parsed.url,
        clientName: parsed.clientName,
        budgetType: parsed.budgetType,
        budgetMinUsd: parsed.budgetMinUsd,
        budgetMaxUsd: parsed.budgetMaxUsd,
        deadlineAt: parsed.deadlineAt ? new Date(parsed.deadlineAt) : undefined,
      },
    );
    await getDb()
      .update(sourceIntegration)
      .set({ lastSyncAt: new Date() })
      .where(and(eq(sourceIntegration.tenantId, t.id), eq(sourceIntegration.sourceKey, sourceKey)));
    return json({ ok: true, opportunityId: res.opportunityId }, 201);
  } catch (err) {
    if (err instanceof CommandError && err.code === "conflict") return json({ ok: true, duplicate: true }, 200);
    if (err instanceof CommandError) return json({ error: err.message }, 422);
    console.error(JSON.stringify({ level: "error", msg: "inbound intake failed", provider, error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "intake failed" }, 500);
  }
}
