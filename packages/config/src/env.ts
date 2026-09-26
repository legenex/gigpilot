import { z } from "zod";

/**
 * Server-side environment. Parsed lazily so that importing this module in a
 * build step (e.g. `next build`) never throws for variables that are only
 * needed at runtime.
 *
 * Secret values are never logged. Use `describeEnv()` for diagnostics.
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.string().default("postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot"),

  /** Public origin of the marketing site (gigpilot.ai in production). */
  WEB_URL: z.string().url().default("http://localhost:4710"),
  /** Public origin of the dashboard (app.gigpilot.ai in production). */
  APP_URL: z.string().url().default("http://localhost:4711"),
  /** Canonical production domains, kept for metadata/SEO even when running locally. */
  CANONICAL_WEB_URL: z.string().url().default("https://gigpilot.ai"),
  CANONICAL_APP_URL: z.string().url().default("https://app.gigpilot.ai"),

  /** Cookie domain for cross-subdomain sessions, e.g. ".gigpilot.ai". Unset locally. */
  AUTH_COOKIE_DOMAIN: optionalSecret,
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  /** Comma separated extra trusted origins for auth (e.g. Tailscale hostnames). */
  AUTH_TRUSTED_ORIGINS: z.string().optional(),
  /** open | invite — invite restricts signup to AUTH_ALLOWED_EMAILS / domains. */
  SIGNUP_MODE: z.enum(["open", "invite"]).default("open"),
  AUTH_ALLOWED_EMAILS: z.string().optional(),
  /** Seed each new workspace with realistic demo data (mock mode). */
  DEMO_SEED_ON_SIGNUP: bool.default(true),

  /** 32-byte key (base64 or hex) used to encrypt per-tenant provider credentials at rest. */
  GIGPILOT_ENCRYPTION_KEY: optionalSecret,
  /** Shared bearer token for the AgentOS supervision API. */
  AGENTOS_SUPERVISION_TOKEN: optionalSecret,
  AGENTOS_BASE_URL: z.string().optional(),
  AGENTOS_STATUS_FILE: z.string().default("/srv/projects/gigpilot/status/agentos.json"),
  AGENTOS_PUSH_ENABLED: bool.default(false),
  AGENTOS_PUSH_TOKEN: optionalSecret,

  STORAGE_DRIVER: z.enum(["filesystem", "s3"]).default("filesystem"),
  STORAGE_ROOT: z.string().default("./var/storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: optionalSecret,
  S3_SECRET_ACCESS_KEY: optionalSecret,

  /** Worker health/ops HTTP port (loopback). */
  WORKER_HEALTH_PORT: z.coerce.number().int().default(4712),
  /** Disable all scheduled jobs (useful for tests). */
  WORKER_SCHEDULES_ENABLED: bool.default(true),

  // --- Intelligence providers -------------------------------------------------
  FACTORY_API_KEY: optionalSecret,
  FACTORY_DROID_BIN: z.string().default("droid"),
  /** Factory model id; "auto" uses Factory Router. */
  FACTORY_MODEL: z.string().default("auto"),
  FACTORY_TIMEOUT_MS: z.coerce.number().int().default(600_000),
  /**
   * Factory's `droid exec` runs as a child process of the worker. It is only
   * used when this is explicitly true: a droid in the worker's container can
   * read /proc/<worker>/environ and /run/secrets, so production must use an
   * isolated sandbox runner instead. Default false → needs_configuration.
   */
  FACTORY_ALLOW_IN_PROCESS: bool.default(false),

  GX_BASE_URL: z.string().optional(),
  GX_API_KEY: optionalSecret,
  GX_MODEL_FAST: z.string().default("gx-mini"),
  GX_MODEL_CODE: z.string().default("gx-code"),
  GX_MODEL_AUTO: z.string().default("gx-auto"),
  GX_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Max concurrent GigPilot requests to heavy GX models (gx-code/gx-auto): 2 slots cluster-wide, shared. */
  GX_CODE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  GX_TIMEOUT_MS: z.coerce.number().int().default(180_000),
  /** Max wait for a GX concurrency slot before the call fails with a timeout (router falls through). */
  GX_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(1).default(120_000),

  XAI_API_KEY: optionalSecret,
  XAI_BASE_URL: z.string().default("https://api.x.ai/v1"),
  /** grok-4.3 is the cheap tier; grok-4.7 is flagship. Old *-fast slugs were retired 2026-05-15. */
  XAI_MODEL: z.string().default("grok-4.3"),
  XAI_MODEL_PREMIUM: z.string().default("grok-4.7"),

  // --- Creative providers -----------------------------------------------------
  KIE_API_KEY: optionalSecret,
  KIE_BASE_URL: z.string().default("https://api.kie.ai"),
  KIE_WEBHOOK_HMAC_KEY: optionalSecret,
  KIE_POLL_TIMEOUT_MS: z.coerce.number().int().default(900_000),
  HIGGSFIELD_API_KEY: optionalSecret,
  HIGGSFIELD_API_SECRET: optionalSecret,
  HIGGSFIELD_BASE_URL: z.string().default("https://api.higgsfield.ai"),
  HIGGSFIELD_POLL_TIMEOUT_MS: z.coerce.number().int().default(900_000),

  // --- Marketplaces -----------------------------------------------------------
  UPWORK_CLIENT_ID: optionalSecret,
  UPWORK_CLIENT_SECRET: optionalSecret,
  UPWORK_ACCESS_TOKEN: optionalSecret,
  FREELANCER_OAUTH_TOKEN: optionalSecret,
  FREELANCER_BASE_URL: z.string().default("https://www.freelancer.com/api"),
  FREELANCER_CLIENT_ID: optionalSecret,
  FREELANCER_CLIENT_SECRET: optionalSecret,
  INBOUND_WEBHOOK_SECRET: optionalSecret,

  /**
   * Real-money guardrail. Paid providers are never called unless a positive
   * daily budget is configured here AND in tenant settings. Default 0 = mock/test mode.
   */
  PAID_PROVIDER_DAILY_BUDGET_USD: z.coerce.number().min(0).default(0),

  // --- Operator / tenant boundaries (security review H1, M6) ------------------
  /**
   * Comma separated exact email addresses of the server operator(s). A
   * workspace is an *operator workspace* when any owner/admin member's email is
   * listed. Only operator workspaces may fall back to server-wide env
   * credentials (FACTORY_API_KEY, XAI_API_KEY, KIE_API_KEY, marketplace
   * tokens…); every other workspace must store its own. Not a secret. List
   * only accounts that already exist (emails are unique, first sign-up wins).
   */
  OPERATOR_EMAILS: z.string().optional(),
  /**
   * Ceiling for a NON-operator workspace's `limits.dailyPaidSpendLimitUsd`.
   * Default 0 = tenants cannot enable real-money spend. Operator workspaces
   * are capped by PAID_PROVIDER_DAILY_BUDGET_USD instead.
   */
  TENANT_MAX_DAILY_PAID_USD: z.coerce.number().min(0).default(0),
  /**
   * Invite mode only: allow "@domain" entries in AUTH_ALLOWED_EMAILS. Domain
   * entries are only safe with verified email ownership, which needs an email
   * sender (not configured in V1) — leave false and list exact addresses.
   */
  AUTH_REQUIRE_EMAIL_VERIFICATION: bool.default(false),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid GigPilot environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}

const SECRET_KEYS = new Set<keyof Env>([
  "BETTER_AUTH_SECRET",
  "GIGPILOT_ENCRYPTION_KEY",
  "AGENTOS_SUPERVISION_TOKEN",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "FACTORY_API_KEY",
  "GX_API_KEY",
  "XAI_API_KEY",
  "KIE_API_KEY",
  "HIGGSFIELD_API_KEY",
  "HIGGSFIELD_API_SECRET",
  "UPWORK_CLIENT_ID",
  "UPWORK_CLIENT_SECRET",
  "FREELANCER_OAUTH_TOKEN",
  "INBOUND_WEBHOOK_SECRET",
  "KIE_WEBHOOK_HMAC_KEY",
  "FREELANCER_CLIENT_ID",
  "FREELANCER_CLIENT_SECRET",
  "UPWORK_ACCESS_TOKEN",
  "AGENTOS_PUSH_TOKEN",
]);

/** Diagnostic view of the environment with secrets reduced to presence flags. */
export function describeEnv(e: Env = env()): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(e)) {
    if (SECRET_KEYS.has(k as keyof Env)) out[k] = v ? "[set]" : "[unset]";
    else if (k === "DATABASE_URL") out[k] = String(v).replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
    else out[k] = v as string | number | boolean;
  }
  return out;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key as keyof Env);
}
