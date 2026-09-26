import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb, sql } from "@gigpilot/db";
import { isEmailAllowed, signupPolicyWarnings, type SignupPolicy } from "./policy";
import {
  SIGNIN_LOCK_MS,
  SIGNIN_MAX_FAILURES,
  SIGNIN_WINDOW_MS,
  afterFailure,
  clearSigninFailures,
  lockRemainingMs,
  readBackoff,
  recordSigninFailure,
  signinBackoffKey,
} from "./signin-backoff";

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

describe("invite-mode sign-up policy (M6)", () => {
  const invite = (allowed: string[], requireEmailVerification = false): SignupPolicy => ({ mode: "invite", allowed, requireEmailVerification });

  it("open mode allows everyone", () => {
    expect(isEmailAllowed("anyone@anywhere.io", { mode: "open", allowed: [], requireEmailVerification: false })).toBe(true);
  });

  it("allows exact addresses only (case/whitespace-insensitive)", () => {
    const p = invite(["Owner@Legenex.com", " ops@gigpilot.test "]);
    expect(isEmailAllowed("owner@legenex.com", p)).toBe(true);
    expect(isEmailAllowed(" OWNER@legenex.com ", p)).toBe(true);
    expect(isEmailAllowed("ops@gigpilot.test", p)).toBe(true);
    expect(isEmailAllowed("owner@legenex.com.evil.io", p)).toBe(false);
    expect(isEmailAllowed("x-owner@legenex.com", p)).toBe(false);
    expect(isEmailAllowed("not-an-email", p)).toBe(false);
  });

  it("ignores @domain entries unless email verification is required", () => {
    expect(isEmailAllowed("attacker@legenex.com", invite(["@legenex.com"]))).toBe(false);
    expect(isEmailAllowed("attacker@legenex.com", invite(["@legenex.com"], true))).toBe(true);
    expect(isEmailAllowed("a@evil-legenex.com", invite(["@legenex.com"], true))).toBe(false);
  });

  it("warns about open sign-up on a public URL and ignored domain entries", () => {
    expect(signupPolicyWarnings({ mode: "open", allowed: [], requireEmailVerification: false }, "https://app.gigpilot.ai").join(" ")).toMatch(/SIGNUP_MODE=open/);
    expect(signupPolicyWarnings({ mode: "open", allowed: [], requireEmailVerification: false }, "http://100.105.214.61:4711")).toEqual([]);
    const w = signupPolicyWarnings(invite(["@legenex.com", "owner@legenex.com"]), "https://app.gigpilot.ai").join(" ");
    expect(w).toMatch(/IGNORED/);
    expect(signupPolicyWarnings(invite(["@legenex.com"]), "http://x").join(" ")).toMatch(/nobody can sign up/);
    expect(signupPolicyWarnings(invite(["@legenex.com"], true), "http://x").join(" ")).toMatch(/no email sender/);
  });
});

describe("per-account sign-in backoff (M2)", () => {
  const t0 = 1_790_000_000_000;

  it("locks after 5 failures within 15 minutes, for 15 minutes", () => {
    let row = null as ReturnType<typeof afterFailure> | null;
    for (let i = 1; i < SIGNIN_MAX_FAILURES; i++) {
      row = afterFailure(row, t0 + i * 1000);
      expect(lockRemainingMs(row, t0 + i * 1000)).toBe(0);
    }
    row = afterFailure(row, t0 + 10_000);
    expect(row.count).toBe(SIGNIN_MAX_FAILURES);
    expect(lockRemainingMs(row, t0 + 10_000)).toBe(SIGNIN_LOCK_MS);
    expect(lockRemainingMs(row, t0 + 10_000 + SIGNIN_LOCK_MS - 1)).toBe(1);
    expect(lockRemainingMs(row, t0 + 10_000 + SIGNIN_LOCK_MS)).toBe(0);
    // After the lock expires the next failure starts a fresh window.
    expect(afterFailure(row, t0 + 10_000 + SIGNIN_LOCK_MS)).toEqual({ count: 1, expiresAt: t0 + 10_000 + SIGNIN_LOCK_MS + SIGNIN_WINDOW_MS });
  });

  it("failures spread beyond the window never lock", () => {
    let row = null as ReturnType<typeof afterFailure> | null;
    for (let i = 0; i < 20; i++) {
      row = afterFailure(row, t0 + i * (SIGNIN_WINDOW_MS / 4 + 1));
      expect(lockRemainingMs(row, t0 + i * (SIGNIN_WINDOW_MS / 4 + 1))).toBe(0);
    }
  });

  it("keys on a keyed hash of the normalised email (address never stored)", () => {
    expect(signinBackoffKey(" Owner@Example.com ")).toBe(signinBackoffKey("owner@example.com"));
    expect(signinBackoffKey("owner@example.com")).not.toContain("owner");
    expect(signinBackoffKey("owner@example.com")).toMatch(/^signin:[0-9a-f]{40}$/);
  });

  describe("DB counter (rate_limit table)", () => {
    const email = `backoff-${randomUUID()}@gigpilot-test.local`;
    afterAll(async () => {
      await clearSigninFailures(email).catch(() => undefined);
      await closeDb();
    });

    it("counts atomically, locks, survives Better Auth pruning, and clears on success", async () => {
      const now = Date.now();
      const results = await Promise.all(Array.from({ length: SIGNIN_MAX_FAILURES }, () => recordSigninFailure(email, now)));
      expect(results.map((r) => r.count).sort()).toEqual([1, 2, 3, 4, 5]);
      const row = await readBackoff(email);
      expect(row?.count).toBe(SIGNIN_MAX_FAILURES);
      expect(lockRemainingMs(row, now)).toBe(SIGNIN_LOCK_MS);
      // Better Auth deletes rows whose last_request < now − longestWindow; ours hold a future expiry.
      await getDb().execute(sql`delete from rate_limit where last_request < ${now - 60_000}`);
      expect((await readBackoff(email))?.count).toBe(SIGNIN_MAX_FAILURES);
      await clearSigninFailures(email);
      expect(await readBackoff(email)).toBeNull();
    });
  });
});
