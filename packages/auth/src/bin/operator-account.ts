/**
 * Operator account bootstrap / password reset (server operator only).
 *
 * Run from the repo root against the production database:
 *
 *   printf '%s' '{"email":"nick@legenex.com","name":"Nick","workspaceName":"GigPilot","password":"…"}' \
 *     | DATABASE_URL=postgres://… BETTER_AUTH_SECRET=… \
 *       pnpm --filter @gigpilot/auth ops:operator-account
 *
 * Input (stdin JSON): email (required), name, workspaceName, password (required).
 * The password is read from stdin — never from argv (visible in `ps`), never
 * logged, never stored anywhere except through Better Auth's own credential
 * hashing. Idempotent:
 *   * existing user → password reset + mustChangePassword=true + all sessions
 *     revoked + owner membership ensured (workspace untouched);
 *   * new user → created through Better Auth's sign-up (so hashing, workspace
 *     bootstrap and its owner membership follow the normal path) as a LIVE
 *     workspace named after workspaceName, then flag + revoke as above.
 * Never touches other tenants.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

interface OperatorInput {
  email: string;
  name?: string;
  workspaceName?: string;
  password: string;
}

function fail(msg: string): never {
  console.error(JSON.stringify({ level: "error", msg }));
  process.exit(1);
}

async function main(): Promise<void> {
  const input: OperatorInput = JSON.parse(readFileSync(0, "utf8"));
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) fail("A valid email is required.");
  if (typeof input.password !== "string" || input.password.length < 10) fail("A password of at least 10 characters is required.");
  // New workspaces created by this bootstrap are LIVE operator workspaces,
  // not demo-seeded. Must be set before the first env() call.
  process.env.DEMO_SEED_ON_SIGNUP = "false";

  const { getAuth, resetUserPassword } = await import("../server");
  const { audit, bootstrapTenantForUser, closeDb, eq, getDb, getMembership, membership, session, sql, tenant, user: userTable } = await import("@gigpilot/db");

  const db = getDb();
  const email = input.email.trim();
  const existing = await db
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = ${email.toLowerCase()}`)
    .limit(1);
  let userId: string;
  let created = false;
  if (existing[0]) {
    userId = existing[0].id;
    await resetUserPassword(existing[0].email, input.password);
  } else {
    const res = await getAuth().api.signUpEmail({
      body: { name: input.name ?? email.split("@")[0]!, email, password: input.password },
    });
    if (!res?.user?.id) fail("Better Auth sign-up failed — check SIGNUP_MODE/AUTH_ALLOWED_EMAILS.");
    userId = res.user.id;
    created = true;
  }

  // Workspace: use the existing one, or bootstrap (and name) a live one.
  let m = await getMembership(db, userId);
  if (!m) {
    const boot = await bootstrapTenantForUser(db, { userId, name: input.name ?? "Operator", email, mode: "live" });
    if (created) {
      await db
        .update(tenant)
        .set({ name: input.workspaceName ?? "GigPilot" })
        .where(eq(tenant.id, boot.tenantId));
    }
    m = await getMembership(db, userId);
  }
  if (!m) fail("Workspace bootstrap failed.");
  if (m.role !== "owner") {
    await db.update(membership).set({ role: "owner" }).where(eq(membership.userId, userId));
  }

  // Force the first-login password change and revoke every live session.
  await db.update(userTable).set({ mustChangePassword: true }).where(eq(userTable.id, userId));
  const revoked = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });

  await audit(db, {
    tenantId: m.tenantId,
    actor: { type: "system", id: `operator-account-${randomUUID().slice(0, 8)}` },
    action: "user.password_bootstrapped",
    subjectType: "user",
    subjectId: userId,
    data: { created, mustChangePassword: true, sessionsRevoked: revoked.length, role: "owner" },
  });

  const out = await getMembership(db, userId);
  console.log(
    JSON.stringify({
      level: "info",
      msg: "operator account bootstrapped",
      email,
      userId,
      tenantId: m.tenantId,
      tenantName: out?.tenantName ?? m.tenantName,
      tenantMode: out?.tenantMode ?? m.tenantMode,
      role: out?.role ?? "owner",
      mustChangePassword: true,
      sessionsRevoked: revoked.length,
    }),
  );
  await closeDb();
}

main().catch((err) => fail(String(err?.message ?? err)));
