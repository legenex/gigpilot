import { notification, type Executor } from "@gigpilot/db";

export interface NotifyInput {
  tenantId: string;
  kind: "approval" | "alert" | "info" | "success";
  title: string;
  body?: string;
  link?: string | null;
  /** Repeated notifications with the same key are ignored. */
  dedupeKey?: string | null;
}

/** Internal notification (never sent externally). Deduplicated by (tenant, dedupeKey). */
export async function notify(db: Executor, input: NotifyInput): Promise<boolean> {
  const rows = await db
    .insert(notification)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: (input.body ?? "").slice(0, 2000),
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: notification.id });
  return rows.length > 0;
}
