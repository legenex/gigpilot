import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, eq, getDb, session as sessionTable, user as userTable } from "@gigpilot/db";
// Test-only deep import (intentionally not part of the package's public API).
import { runMigrations } from "../../db/src/migrate";
import { completeForcedPasswordChange, ForcedPasswordError, getAuth, getSessionContext, resetUserPassword } from "./server";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
(function useTestDatabase() {
  const envFile = path.join(repoRoot, ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    }
  }
  const u = new URL(process.env.DATABASE_URL ?? "postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot");
  u.pathname = "/gigpilot_test";
  process.env.DATABASE_URL = u.toString();
  process.env.GIGPILOT_SERVICE = "gigpilot-test";
})();

/**
 * Signs up through Better Auth's real endpoint and returns request headers
 * carrying the real signed session cookie (the cookie value is signed, so
 * the raw session token cannot be used as a cookie directly).
 */
async function signUpWithSession(input: { name: string; email: string; password: string }): Promise<{ headers: Headers; userId: string }> {
  const res = await getAuth().api.signUpEmail({ body: input, asResponse: true });
  if (!res.ok) throw new Error(`sign-up failed (${res.status})`);
  const pair = res.headers.getSetCookie().find((c) => c.startsWith("gigpilot.session_token="))?.split(";")[0];
  const body = (await res.json()) as { user?: { id?: string } };
  if (!pair || !body.user?.id) throw new Error("sign-up response missing session cookie or user");
  return { headers: new Headers({ cookie: pair }), userId: body.user.id };
}

// The shared test database deliberately has NO pgboss schema (the worker
// readiness test asserts the queue check fails without it), so the sign-up
// hook's kickoff enqueues are routed to a recording stub — the same trick the
// agents test harness uses.
interface BossGlobal {
  __gigpilotBoss?: Promise<unknown>;
}
(globalThis as unknown as BossGlobal).__gigpilotBoss = Promise.resolve({
  send: async () => "recorded",
});

describe("forced first-login password change", () => {
  beforeAll(async () => {
    await runMigrations(path.join(repoRoot, "packages/db/migrations"));
  });
  afterAll(async () => {
    await closeDb();
  });

  it("gates the session, then completes the change through Better Auth's own flow", async () => {
    const email = `fp-${randomUUID()}@gigpilot-test.local`;
    const { headers, userId } = await signUpWithSession({ name: "Forced Pilot", email, password: "first-login-temp-42" });
    const db = getDb();
    await db.update(userTable).set({ mustChangePassword: true }).where(eq(userTable.id, userId));

    const ctx = await getSessionContext(headers);
    expect(ctx?.mustChangePassword).toBe(true);
    expect(ctx?.role).toBe("owner");

    // A second session (another device) must be revoked by the change; the changing session survives.
    const other = await getAuth().api.signInEmail({ body: { email, password: "first-login-temp-42" } });
    expect(other?.token).toBeTruthy();

    await completeForcedPasswordChange(headers, "permanent-pass-77");

    expect((await getSessionContext(headers))?.mustChangePassword).toBe(false);
    const rows = await db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.userId, userId));
    expect(rows).toHaveLength(1);

    // The temporary password no longer works; the permanent one does.
    await expect(getAuth().api.signInEmail({ body: { email, password: "first-login-temp-42" } })).rejects.toThrow();
    const fresh = await getAuth().api.signInEmail({ body: { email, password: "permanent-pass-77" } });
    expect(fresh?.user?.id).toBe(userId);
  });

  it("refuses the change without a session, without the flag, or with a weak password", async () => {
    const email = `fp-${randomUUID()}@gigpilot-test.local`;
    const { headers, userId } = await signUpWithSession({ name: "Fresh Pilot", email, password: "initial-pass-42" });
    const db = getDb();

    // No flag → nothing to change.
    await expect(completeForcedPasswordChange(headers, "permanent-pass-77")).rejects.toBeInstanceOf(ForcedPasswordError);
    // Signed out → refused.
    await expect(completeForcedPasswordChange(new Headers(), "permanent-pass-77")).rejects.toBeInstanceOf(ForcedPasswordError);

    // Weak password → Better Auth's own policy refuses it; the flag stays armed.
    await db.update(userTable).set({ mustChangePassword: true }).where(eq(userTable.id, userId));
    await expect(completeForcedPasswordChange(headers, "short")).rejects.toThrow();
    expect((await getSessionContext(headers))?.mustChangePassword).toBe(true);

    // A valid retry succeeds after the refused one.
    await completeForcedPasswordChange(headers, "permanent-pass-88");
    expect((await getSessionContext(headers))?.mustChangePassword).toBe(false);
  });

  it("resetUserPassword re-arms credentials without the current password (operator bootstrap)", async () => {
    const email = `fp-${randomUUID()}@gigpilot-test.local`;
    await getAuth().api.signUpEmail({ body: { name: "Reset Pilot", email, password: "initial-pass-42" } });
    await resetUserPassword(email, "bootstrap-again-42");
    const fresh = await getAuth().api.signInEmail({ body: { email, password: "bootstrap-again-42" } });
    expect(fresh?.user?.id).toBeTruthy();
    await expect(getAuth().api.signInEmail({ body: { email, password: "initial-pass-42" } })).rejects.toThrow();
  });
});
