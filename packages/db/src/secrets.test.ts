import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "./client";
import { runMigrations } from "./migrate";
import { membership, providerSecret, tenant, user } from "./schema";
import {
  SHAREABLE_ENV_CREDENTIALS,
  decryptSecret,
  encryptSecret,
  envCredentialAllowed,
  getTenantSecret,
  resolveSecret,
  saveTenantSecret,
  secretAad,
} from "./secrets";
import { bootstrapTenantForUser, clearOperatorTenantCache, isOperatorTenant, paidSpendCeilingUsd, parseOperatorEmails } from "./tenancy";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** Point this file at the dedicated gigpilot_test database (never dev/prod). */
function useTestDatabase() {
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
}

useTestDatabase();
process.env.GIGPILOT_ENCRYPTION_KEY = randomBytes(32).toString("base64");

describe("tenant secret encryption (v2 AAD, L10)", () => {
  const aad = secretAad("tenant-a", "kie", "KIE_API_KEY");

  it("binds ciphertext to tenant|provider|name", () => {
    const blob = encryptSecret("sk-live-abc", aad);
    expect(blob.startsWith("v2:")).toBe(true);
    expect(blob).not.toContain("sk-live-abc");
    expect(decryptSecret(blob, aad)).toBe("sk-live-abc");
    expect(() => decryptSecret(blob, secretAad("tenant-b", "kie", "KIE_API_KEY"))).toThrow();
    expect(() => decryptSecret(blob, secretAad("tenant-a", "grok", "KIE_API_KEY"))).toThrow();
    expect(() => decryptSecret(blob, secretAad("tenant-a", "kie", "XAI_API_KEY"))).toThrow();
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("still decrypts legacy v1 blobs and rejects tampering / unknown formats", () => {
    const v1 = encryptSecret("legacy-value");
    expect(v1.startsWith("v1:")).toBe(true);
    expect(decryptSecret(v1)).toBe("legacy-value");
    expect(decryptSecret(v1, aad)).toBe("legacy-value");
    const [v, iv, tag, ct] = encryptSecret("x-value", aad).split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join(":"), aad)).toThrow();
    expect(() => decryptSecret("v3:a:b:c", aad)).toThrow();
    expect(() => decryptSecret("garbage", aad)).toThrow();
  });
});

describe("operator emails", () => {
  it("accepts only exact addresses, lower-cased and de-duplicated", () => {
    expect(parseOperatorEmails(" Owner@Example.com, @example.com ,bad, owner@example.com,ops@x.io ")).toEqual(["owner@example.com", "ops@x.io"]);
    expect(parseOperatorEmails(undefined)).toEqual([]);
  });

  it("caps paid spend: operators by the server budget, tenants by min(TENANT_MAX, server)", () => {
    const saved = { a: process.env.PAID_PROVIDER_DAILY_BUDGET_USD, b: process.env.TENANT_MAX_DAILY_PAID_USD };
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "25";
    delete process.env.TENANT_MAX_DAILY_PAID_USD;
    expect(paidSpendCeilingUsd(true)).toBe(25);
    expect(paidSpendCeilingUsd(false)).toBe(0);
    process.env.TENANT_MAX_DAILY_PAID_USD = "5";
    expect(paidSpendCeilingUsd(false)).toBe(5);
    process.env.TENANT_MAX_DAILY_PAID_USD = "50";
    expect(paidSpendCeilingUsd(false)).toBe(25);
    process.env.PAID_PROVIDER_DAILY_BUDGET_USD = "0";
    expect(paidSpendCeilingUsd(true)).toBe(0);
    for (const [k, v] of [["PAID_PROVIDER_DAILY_BUDGET_USD", saved.a], ["TENANT_MAX_DAILY_PAID_USD", saved.b]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

describe("resolveSecret env fallback policy (H1, DB-backed)", () => {
  const run = randomUUID().slice(0, 8);
  const operatorEmail = `op-${run}@gigpilot-test.local`;
  const tenantEmail = `user-${run}@gigpilot-test.local`;
  let opTenant = "";
  let userTenant = "";
  const userIds: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    GX_API_KEY: "env-gx",
    KIE_API_KEY: "env-kie",
    FACTORY_API_KEY: "env-factory",
    XAI_API_KEY: "env-xai",
    HIGGSFIELD_API_KEY: "env-hf",
    FREELANCER_OAUTH_TOKEN: "env-fl",
    UPWORK_ACCESS_TOKEN: "env-up",
  };

  async function makeUser(email: string): Promise<string> {
    const id = `test-${randomUUID()}`;
    await getDb().insert(user).values({ id, name: email.split("@")[0]!, email, emailVerified: false });
    userIds.push(id);
    const { tenantId } = await bootstrapTenantForUser(getDb(), { userId: id, name: "Test", email, mode: "live" });
    return tenantId;
  }

  beforeAll(async () => {
    await runMigrations(path.join(repoRoot, "packages/db/migrations"));
    for (const k of [...Object.keys(ENV), "OPERATOR_EMAILS"]) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    opTenant = await makeUser(operatorEmail);
    userTenant = await makeUser(tenantEmail);
    process.env.OPERATOR_EMAILS = `someone-else@x.io, ${operatorEmail.toUpperCase()}`;
  });

  beforeEach(() => clearOperatorTenantCache());

  afterAll(async () => {
    const db = getDb();
    for (const t of [opTenant, userTenant]) if (t) await db.delete(tenant).where(eq(tenant.id, t));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeDb();
  });

  it("recognises operator workspaces by owner/admin email (case-insensitive) and caches the decision", async () => {
    expect(await isOperatorTenant(getDb(), opTenant)).toBe(true);
    expect(await isOperatorTenant(getDb(), userTenant)).toBe(false);
    // Demoting the operator to "member" takes effect after the cache is dropped (≤ 60 s in production).
    await getDb().update(membership).set({ role: "member" }).where(eq(membership.tenantId, opTenant));
    expect(await isOperatorTenant(getDb(), opTenant)).toBe(true);
    clearOperatorTenantCache(opTenant);
    expect(await isOperatorTenant(getDb(), opTenant)).toBe(false);
    await getDb().update(membership).set({ role: "owner" }).where(eq(membership.tenantId, opTenant));
    clearOperatorTenantCache();
    const savedList = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "";
    expect(await isOperatorTenant(getDb(), opTenant)).toBe(false);
    process.env.OPERATOR_EMAILS = savedList;
  });

  it("non-operator workspaces never inherit paid or marketplace env credentials", async () => {
    for (const [provider, name] of [
      ["kie", "KIE_API_KEY"],
      ["factory", "FACTORY_API_KEY"],
      ["grok", "XAI_API_KEY"],
      ["higgsfield", "HIGGSFIELD_API_KEY"],
      ["freelancer", "FREELANCER_OAUTH_TOKEN"],
      ["upwork", "UPWORK_ACCESS_TOKEN"],
    ] as const) {
      expect(await resolveSecret(getDb(), userTenant, provider, name), name).toBeUndefined();
      expect(await resolveSecret(getDb(), opTenant, provider, name), name).toBe(process.env[name]);
    }
  });

  it("shares only SHAREABLE_ENV_CREDENTIALS (the GX gateway) with every workspace; null tenant = system context", async () => {
    expect([...SHAREABLE_ENV_CREDENTIALS]).toEqual(["GX_API_KEY"]);
    expect(await resolveSecret(getDb(), userTenant, "gx", "GX_API_KEY")).toBe("env-gx");
    expect(await envCredentialAllowed(getDb(), userTenant, "GX_API_KEY")).toBe(true);
    expect(await envCredentialAllowed(getDb(), userTenant, "KIE_API_KEY")).toBe(false);
    expect(await resolveSecret(getDb(), null, "kie", "KIE_API_KEY")).toBe("env-kie");
  });

  it("a workspace's own secret wins, and v1 rows are upgraded to v2 on read", async () => {
    await saveTenantSecret(getDb(), userTenant, "kie", "KIE_API_KEY", "tenant-kie-key-123");
    expect(await resolveSecret(getDb(), userTenant, "kie", "KIE_API_KEY")).toBe("tenant-kie-key-123");
    const [row] = await getDb().select().from(providerSecret).where(and(eq(providerSecret.tenantId, userTenant), eq(providerSecret.name, "KIE_API_KEY")));
    expect(row!.ciphertext.startsWith("v2:")).toBe(true);
    expect(row!.hint).toBe("••••-123");

    // A ciphertext copied into another tenant's row does not decrypt there.
    await getDb().insert(providerSecret).values({ tenantId: opTenant, providerKey: "kie", name: "KIE_API_KEY", ciphertext: row!.ciphertext, hint: row!.hint });
    expect(await getTenantSecret(getDb(), opTenant, "kie", "KIE_API_KEY")).toBeUndefined();

    // Legacy v1 row → still readable, then rewritten as v2.
    await getDb().update(providerSecret).set({ ciphertext: encryptSecret("legacy-kie-key") }).where(and(eq(providerSecret.tenantId, userTenant), eq(providerSecret.name, "KIE_API_KEY")));
    expect(await getTenantSecret(getDb(), userTenant, "kie", "KIE_API_KEY")).toBe("legacy-kie-key");
    const [after] = await getDb().select().from(providerSecret).where(and(eq(providerSecret.tenantId, userTenant), eq(providerSecret.name, "KIE_API_KEY")));
    expect(after!.ciphertext.startsWith("v2:")).toBe(true);
    expect(decryptSecret(after!.ciphertext, secretAad(userTenant, "kie", "KIE_API_KEY"))).toBe("legacy-kie-key");
  });
});
