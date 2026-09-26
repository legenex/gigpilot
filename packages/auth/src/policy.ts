/**
 * Pure sign-up / deployment policy helpers (unit tested, no I/O).
 */

export function splitList(v?: string): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SignupPolicy {
  mode: "open" | "invite";
  /** Raw AUTH_ALLOWED_EMAILS entries: exact addresses and (optionally) "@domain". */
  allowed: string[];
  /**
   * AUTH_REQUIRE_EMAIL_VERIFICATION. Domain entries ("@example.com") prove
   * nothing without verified email ownership — anyone can type any address —
   * so they are honoured ONLY when verification is required (which needs an
   * email sender; none is configured in V1).
   */
  requireEmailVerification: boolean;
}

const EXACT_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const DOMAIN_ENTRY = /^@[^\s@,]+\.[^\s@,]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Invite mode: exact-address entries always; "@domain" entries only with
 * required email verification. Open mode: everyone.
 */
export function isEmailAllowed(email: string, policy: SignupPolicy): boolean {
  if (policy.mode === "open") return true;
  const e = normalizeEmail(email);
  if (!EXACT_EMAIL.test(e)) return false;
  for (const raw of policy.allowed) {
    const a = raw.trim().toLowerCase();
    if (EXACT_EMAIL.test(a) && a === e) return true;
    if (policy.requireEmailVerification && DOMAIN_ENTRY.test(a) && e.endsWith(a)) return true;
  }
  return false;
}

/** Operator-facing startup warnings (never include secret values). */
export function signupPolicyWarnings(policy: SignupPolicy, appUrl: string): string[] {
  const out: string[] = [];
  const isPublic = appUrl.startsWith("https://");
  if (policy.mode === "open" && isPublic) {
    out.push(
      "SIGNUP_MODE=open on a public (https) APP_URL: anyone can create a workspace. Set SIGNUP_MODE=invite with exact AUTH_ALLOWED_EMAILS addresses before exposing GigPilot publicly.",
    );
  }
  if (policy.mode === "invite") {
    const domains = policy.allowed.filter((a) => a.trim().startsWith("@"));
    if (domains.length && !policy.requireEmailVerification) {
      out.push(
        `AUTH_ALLOWED_EMAILS has ${domains.length} "@domain" entr${domains.length === 1 ? "y" : "ies"} that are IGNORED: without email verification anyone could claim an address on that domain. List exact addresses, or set AUTH_REQUIRE_EMAIL_VERIFICATION=true once an email sender is configured.`,
      );
    }
    if (!policy.allowed.some((a) => EXACT_EMAIL.test(a.trim().toLowerCase())) && !(policy.requireEmailVerification && domains.length)) {
      out.push("SIGNUP_MODE=invite but AUTH_ALLOWED_EMAILS has no usable entries: nobody can sign up.");
    }
  }
  if (policy.requireEmailVerification) {
    out.push("AUTH_REQUIRE_EMAIL_VERIFICATION=true but no email sender is configured in V1: new accounts cannot verify and will not be able to sign in.");
  }
  return out;
}
