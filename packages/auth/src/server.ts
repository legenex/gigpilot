import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies, toNextJsHandler } from "better-auth/next-js";
import { env } from "@gigpilot/config/env";
import { bootstrapTenantForUser, eq, getDb, getMembership, inArray, parseOperatorEmails, schema, sql, user as userTable } from "@gigpilot/db";
import { onWorkspaceCreated } from "./hooks";
import { isEmailAllowed, signupPolicyWarnings, splitList, type SignupPolicy } from "./policy";
import { clearSigninFailures, lockRemainingMs, readBackoff, recordSigninFailure } from "./signin-backoff";

function signupPolicy(): SignupPolicy {
  const e = env();
  return { mode: e.SIGNUP_MODE, allowed: splitList(e.AUTH_ALLOWED_EMAILS), requireEmailVerification: e.AUTH_REQUIRE_EMAIL_VERIFICATION };
}

function warn(msg: string) {
  console.warn(JSON.stringify({ level: "warn", msg }));
}

/**
 * One-time operator warnings (sign-up policy + unregistered operator emails).
 * Called from the dashboard's instrumentation hook at server start and again
 * (no-op) when auth initialises.
 */
export function logAuthStartupWarnings(): void {
  const g = globalThis as unknown as { __gigpilotAuthWarned?: boolean };
  if (g.__gigpilotAuthWarned) return;
  g.__gigpilotAuthWarned = true;
  try {
    logStartupWarnings(env().APP_URL);
  } catch {
    /* never block startup on diagnostics */
  }
}

function logStartupWarnings(appUrl: string) {
  for (const w of signupPolicyWarnings(signupPolicy(), appUrl)) warn(w);
  const operators = parseOperatorEmails();
  if (!operators.length) return;
  void getDb()
    .select({ email: userTable.email })
    .from(userTable)
    .where(inArray(sql`lower(${userTable.email})`, operators))
    .then((rows) => {
      const found = new Set(rows.map((r) => r.email.toLowerCase()));
      const missing = operators.filter((o) => !found.has(o)).length;
      if (missing) {
        warn(`${missing} OPERATOR_EMAILS address(es) have no account yet. Register them now (first sign-up of an email wins) or remove them — an unregistered operator address could be claimed by someone else while sign-up is open.`);
      }
    })
    .catch(() => undefined);
}

function emailFromBody(body: unknown): string | null {
  const v = (body as { email?: unknown } | null | undefined)?.email;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 320) : null;
}

// ---------------------------------------------------------------------------
// Forced first-login password change (operator bootstrap)
//
// V1 has no email transport, so single-use reset tokens minted through
// Better Auth's /request-password-reset are captured in-process by the
// sendResetPassword hook instead of being emailed: a token never leaves the
// server, is consumed immediately by resetUserPassword(), and expires in the
// verification table after resetPasswordTokenExpiresIn (default 1 h). The
// public endpoint stays honest — it mints a token nobody but the server can
// read and returns the same generic response for every address.
// ---------------------------------------------------------------------------

interface CapturedResetToken {
  token: string;
  expiresAt: number;
}

const capturedResetTokens = new Map<string, CapturedResetToken>();

/** How long a captured reset token stays usable after it was minted. */
const CAPTURED_TOKEN_TTL_MS = 60_000;

/**
 * Sets a user's password through Better Auth's own reset-token flow (hashing,
 * account update and token verification are all Better Auth's; no password
 * hash is ever constructed by GigPilot). Used by the operator bootstrap and by
 * completeForcedPasswordChange — the two flows that legitimately change a
 * password without knowing the current one.
 */
export async function resetUserPassword(email: string, newPassword: string): Promise<void> {
  await getAuth().api.requestPasswordReset({ body: { email } });
  const key = email.trim().toLowerCase();
  const deadline = Date.now() + 5_000; // the hook fires within the API call
  let captured: CapturedResetToken | undefined;
  while (!captured && Date.now() < deadline) {
    captured = capturedResetTokens.get(key);
    if (!captured) await new Promise((r) => setTimeout(r, 25));
  }
  capturedResetTokens.delete(key);
  if (!captured || captured.expiresAt <= Date.now()) {
    throw new Error("Could not start the password change. Try again.");
  }
  await getAuth().api.resetPassword({ body: { newPassword, token: captured.token } });
}

function createAuth() {
  const e = env();
  const secure = e.APP_URL.startsWith("https://");
  const trustedOrigins = Array.from(new Set([e.WEB_URL, e.APP_URL, ...splitList(e.AUTH_TRUSTED_ORIGINS)]));
  logAuthStartupWarnings();

  return betterAuth({
    appName: "GigPilot",
    baseURL: e.APP_URL,
    basePath: "/api/auth",
    secret: e.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // Needs an email sender (not configured in V1) — see AUTH_REQUIRE_EMAIL_VERIFICATION.
      requireEmailVerification: e.AUTH_REQUIRE_EMAIL_VERIFICATION,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      // No email transport exists in V1: tokens minted by /request-password-reset
      // are captured in-process (never logged, never sent to a client) and
      // consumed immediately by resetUserPassword(). See the note above.
      sendResetPassword: async ({ user: u, token }) => {
        capturedResetTokens.set(u.email.trim().toLowerCase(), { token, expiresAt: Date.now() + CAPTURED_TOKEN_TTL_MS });
      },
    },
    trustedOrigins,
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 120 },
    },
    rateLimit: {
      enabled: e.NODE_ENV === "production",
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: "gigpilot",
      crossSubDomainCookies: e.AUTH_COOKIE_DOMAIN ? { enabled: true, domain: e.AUTH_COOKIE_DOMAIN } : { enabled: false },
      /*
       * Client IP for Better Auth's per-IP rate limits. Trustworthy ONLY
       * behind the GigPilot edge proxy: the Caddy edge (ops/gx10-01/edge,
       * ops/vps) has no trusted_proxies, so it REPLACES any client-supplied
       * X-Forwarded-For with the real peer address and sets X-Real-IP; the
       * app containers publish on 127.0.0.1 only, so clients cannot reach
       * them without the edge. Better Auth accepts a single-value header only
       * (multi-hop chains resolve to no IP). Per-account backoff below does
       * not depend on the IP at all.
       */
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"], ipv6Subnet: 64 },
    },
    hooks: {
      // Per-account sign-in backoff (independent of IP): refuse while locked.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = emailFromBody(ctx.body);
        if (!email) return;
        let remaining = 0;
        try {
          remaining = lockRemainingMs(await readBackoff(email), Date.now());
        } catch {
          remaining = 0; // storage failure must not lock everyone out; per-IP limits still apply
        }
        if (remaining > 0) {
          const minutes = Math.max(1, Math.ceil(remaining / 60_000));
          throw new APIError("TOO_MANY_REQUESTS", {
            message: `Too many failed sign-in attempts for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          });
        }
      }),
      // Count failed password checks; a successful sign-in clears the counter.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = emailFromBody(ctx.body);
        if (!email) return;
        const returned = ctx.context.returned;
        try {
          if (returned instanceof APIError) {
            if (returned.statusCode === 401) await recordSigninFailure(email);
          } else if (ctx.context.newSession) {
            await clearSigninFailures(email);
          }
        } catch (err) {
          console.error(JSON.stringify({ level: "warn", msg: "sign-in backoff update failed", error: err instanceof Error ? err.name : "error" }));
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isEmailAllowed(user.email, signupPolicy())) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is invite-only for this GigPilot instance." });
            }
            return { data: user };
          },
          after: async (user) => {
            const db = getDb();
            const { tenantId, created } = await bootstrapTenantForUser(db, {
              userId: user.id,
              name: user.name,
              email: user.email,
              mode: e.DEMO_SEED_ON_SIGNUP ? "demo" : "live",
            });
            if (created) await onWorkspaceCreated({ tenantId, userId: user.id, demo: e.DEMO_SEED_ON_SIGNUP });
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const g = globalThis as unknown as { __gigpilotAuth?: Auth };

export function getAuth(): Auth {
  if (!g.__gigpilotAuth) g.__gigpilotAuth = createAuth();
  return g.__gigpilotAuth;
}

/** Route handler pair for app/api/auth/[...all]/route.ts. */
export function authRouteHandlers() {
  return toNextJsHandler(getAuth());
}

export interface SessionContext {
  user: { id: string; name: string; email: string; image?: string | null };
  sessionId: string;
  tenantId: string;
  tenantName: string;
  tenantMode: "demo" | "live";
  role: "owner" | "admin" | "member";
  /** True until the user chose their own permanent password (operator bootstrap). */
  mustChangePassword: boolean;
}

/**
 * Authoritative session check (validates against the database / signed
 * cookie cache). Returns null when signed out. Ensures a workspace exists.
 */
export async function getSessionContext(headers: Headers): Promise<SessionContext | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  const db = getDb();
  let m = await getMembership(db, session.user.id);
  if (!m) {
    await bootstrapTenantForUser(db, { userId: session.user.id, name: session.user.name, email: session.user.email });
    m = await getMembership(db, session.user.id);
    if (!m) return null;
  }
  const u = await db
    .select({ mustChangePassword: userTable.mustChangePassword })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image },
    sessionId: session.session.id,
    tenantId: m.tenantId,
    tenantName: m.tenantName,
    tenantMode: m.tenantMode,
    role: m.role,
    mustChangePassword: u[0]?.mustChangePassword ?? false,
  };
}

/** Lightweight signed-in check for marketing pages (no workspace bootstrap). */
export async function isSignedIn(headers: Headers): Promise<{ signedIn: boolean; name?: string }> {
  try {
    const session = await getAuth().api.getSession({ headers });
    return session ? { signedIn: true, name: session.user.name } : { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}

/** Raised when the forced password change cannot proceed (session/flag state). */
export class ForcedPasswordError extends Error {}

/**
 * Completes the forced first-login password change for the session user:
 * the new password is set through Better Auth's own flow (resetUserPassword),
 * all OTHER sessions are revoked (the current session stays signed in), and
 * mustChangePassword is cleared so the dashboard unlocks. No password hash is
 * constructed by GigPilot; Better Auth hashes and stores the credential.
 */
export async function completeForcedPasswordChange(headers: Headers, newPassword: string): Promise<void> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new ForcedPasswordError("Your session expired. Log in again and choose your password.");
  const db = getDb();
  const rows = await db
    .select({ mustChangePassword: userTable.mustChangePassword })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  if (!rows[0]?.mustChangePassword) throw new ForcedPasswordError("No password change is required for this account.");
  await resetUserPassword(session.user.email, newPassword);
  await getAuth().api.revokeOtherSessions({ headers });
  await db.update(userTable).set({ mustChangePassword: false }).where(eq(userTable.id, session.user.id));
}
