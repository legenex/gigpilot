import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies, toNextJsHandler } from "better-auth/next-js";
import { env } from "@gigpilot/config/env";
import { bootstrapTenantForUser, getDb, getMembership, schema } from "@gigpilot/db";
import { onWorkspaceCreated } from "./hooks";

function splitList(v?: string): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEmailAllowed(email: string): boolean {
  const e = env();
  if (e.SIGNUP_MODE === "open") return true;
  const allowed = splitList(e.AUTH_ALLOWED_EMAILS).map((s) => s.toLowerCase());
  const lower = email.toLowerCase();
  return allowed.some((a) => (a.startsWith("@") ? lower.endsWith(a) : lower === a));
}

function createAuth() {
  const e = env();
  const secure = e.APP_URL.startsWith("https://");
  const trustedOrigins = Array.from(new Set([e.WEB_URL, e.APP_URL, ...splitList(e.AUTH_TRUSTED_ORIGINS)]));

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
      minPasswordLength: 10,
      maxPasswordLength: 128,
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
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isEmailAllowed(user.email)) {
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
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image },
    sessionId: session.session.id,
    tenantId: m.tenantId,
    tenantName: m.tenantName,
    tenantMode: m.tenantMode,
    role: m.role,
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
