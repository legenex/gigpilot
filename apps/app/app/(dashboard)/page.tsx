import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionContext } from "@gigpilot/auth";

export const dynamic = "force-dynamic";

export default async function CommandCenter() {
  const ctx = await getSessionContext(await headers());
  if (!ctx) redirect("/login");
  return <main className="p-8">Command Center — {ctx.tenantName}</main>;
}
