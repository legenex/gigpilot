import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { providerSecret } from "./schema";

/**
 * AES-256-GCM encryption for per-tenant provider credentials. The key comes
 * from GIGPILOT_ENCRYPTION_KEY (base64 or hex, 32 bytes). Plaintext secrets
 * never leave the server and are never returned to clients or logged.
 */

function key(): Buffer {
  const raw = process.env.GIGPILOT_ENCRYPTION_KEY;
  if (!raw) throw new Error("GIGPILOT_ENCRYPTION_KEY is not configured");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  // Derive a 32-byte key from any other length deterministically.
  return createHash("sha256").update(buf).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function secretHint(value: string): string {
  const tail = value.slice(-4);
  return `••••${tail}`;
}

export async function saveTenantSecret(db: Executor, tenantId: string, providerKey: string, name: string, value: string): Promise<void> {
  const ciphertext = encryptSecret(value);
  await db
    .insert(providerSecret)
    .values({ tenantId, providerKey, name, ciphertext, hint: secretHint(value) })
    .onConflictDoUpdate({
      target: [providerSecret.tenantId, providerSecret.providerKey, providerSecret.name],
      set: { ciphertext, hint: secretHint(value), updatedAt: new Date() },
    });
}

export async function clearTenantSecret(db: Executor, tenantId: string, providerKey: string, name?: string): Promise<void> {
  const where = name
    ? and(eq(providerSecret.tenantId, tenantId), eq(providerSecret.providerKey, providerKey), eq(providerSecret.name, name))
    : and(eq(providerSecret.tenantId, tenantId), eq(providerSecret.providerKey, providerKey));
  await db.delete(providerSecret).where(where);
}

/** Secret-free listing for the Integrations UI. */
export async function listTenantSecretHints(db: Executor, tenantId: string): Promise<{ providerKey: string; name: string; hint: string; updatedAt: Date }[]> {
  return db
    .select({ providerKey: providerSecret.providerKey, name: providerSecret.name, hint: providerSecret.hint, updatedAt: providerSecret.updatedAt })
    .from(providerSecret)
    .where(eq(providerSecret.tenantId, tenantId));
}

/**
 * Resolve a credential: tenant-stored secret first, then server env var of
 * the same name. Returns undefined when neither is set.
 */
export async function resolveSecret(db: Executor, tenantId: string | null, providerKey: string, name: string): Promise<string | undefined> {
  if (tenantId) {
    const rows = await db
      .select({ ciphertext: providerSecret.ciphertext })
      .from(providerSecret)
      .where(and(eq(providerSecret.tenantId, tenantId), eq(providerSecret.providerKey, providerKey), eq(providerSecret.name, name)))
      .limit(1);
    if (rows[0]) {
      try {
        return decryptSecret(rows[0].ciphertext);
      } catch {
        return undefined;
      }
    }
  }
  const fromEnv = process.env[name];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}
