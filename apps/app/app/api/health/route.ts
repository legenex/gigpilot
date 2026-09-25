import { pingDb } from "@gigpilot/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await pingDb();
  const body = { status: db.ok ? "ok" : "degraded", service: "app", db: { ok: db.ok, latencyMs: db.latencyMs }, time: new Date().toISOString() };
  return Response.json(body, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
