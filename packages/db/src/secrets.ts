import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { providerSecret } from "./schema";
import { isOperatorTenant } from "./tenancy";

/**
 * AES-256-GCM encryption for per-tenant provider credentials. The key comes
 * from GIGPILOT_ENCRYPTION_KEY (base64 or hex, 32 bytes). Plaintext secrets
 * never leave the server and are never returned to clients or logged.
 *
 * Formats:
 *   v2:<iv>:<tag>:<ct>  — AAD = "tenantId|providerKey|name" (current). A
 *                          ciphertext copied to another tenant/provider/name
 *                          row fails authentication instead of decrypting.
 *   v1:<iv>:<tag>:<ct>  — legacy, no AAD. Still decrypted; re-encrypted as v2
 *                          on first successful read.
 */

function key(): Buffer {
  const raw = process.env.GIGPILOT_ENCRYPTION_KEY;
  if (!raw) throw new Error("GIGPILOT_ENCRYPTION_KEY is not configured");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  // Derive a 32-byte key from any other length deterministically.
  return createHash("sha256").update(buf).digest();
}

/** Additional authenticated data binding a ciphertext to its row. */
export function secretAad(tenantId: string, providerKey: string, name: string): string {
  return `${tenantId}|${providerKey}|${name}`;
}

/**
 * Encrypt a secret. With `aad` → v2 (bound to that context); without → v1
 * (legacy, kept only for callers that have no row context).
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${aad !== undefined ? "v2" : "v1"}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt v1 (no AAD) or v2 (requires the same AAD used to encrypt). Throws on tamper/mismatch. */
export function decryptSecret(blob: string, aad?: string): string {
  const [v, iv, tag, ct, ...rest] = blob.split(":");
  if ((v !== "v1" && v !== "v2") || !iv || !tag || ct === undefined || rest.length) throw new Error("Unsupported secret format");
  if (v === "v2" && aad === undefined) throw new Error("Secret context required");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  if (v === "v2") decipher.setAAD(Buffer.from(aad!, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function secretHint(value: string): string {
  const tail = value.slice(-4);
  return `••••${tail}`;
}

export async function saveTenantSecret(db: Executor, tenantId: string, providerKey: string, name: string, value: string): Promise<void> {
  const ciphertext = encryptSecret(value, secretAad(tenantId, providerKey, name));
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
 * The tenant's OWN stored secret (never the server env). Undefined when not
 * stored or when the ciphertext fails authentication.
 */
export async function getTenantSecret(db: Executor, tenantId: string, providerKey: string, name: string): Promise<string | undefined> {
  const rows = await db
    .select({ ciphertext: providerSecret.ciphertext })
    .from(providerSecret)
    .where(and(eq(providerSecret.tenantId, tenantId), eq(providerSecret.providerKey, providerKey), eq(providerSecret.name, name)))
    .limit(1);
  const blob = rows[0]?.ciphertext;
  if (!blob) return undefined;
  const aad = secretAad(tenantId, providerKey, name);
  let value: string;
  try {
    value = decryptSecret(blob, aad);
  } catch {
    return undefined;
  }
  if (blob.startsWith("v1:")) {
    // Lazy upgrade to the AAD-bound format (best effort; a failure keeps v1).
    await db
      .update(providerSecret)
      .set({ ciphertext: encryptSecret(value, aad) })
      .where(and(eq(providerSecret.tenantId, tenantId), eq(providerSecret.providerKey, providerKey), eq(providerSecret.name, name), eq(providerSecret.ciphertext, blob)))
      .catch(() => undefined);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Env fallback policy (security review H1)
// ---------------------------------------------------------------------------

/**
 * Server env credentials that MAY be shared with every workspace. Only the
 * local GX gateway (free, on-host inference; quota-limited per tenant by the
 * worker). GX_BASE_URL is plain server config, not a credential. Everything
 * else — marketplace tokens (Freelancer, Upwork) and paid providers (Factory,
 * xAI, Kie, Higgsfield) — is operator-only.
 */
export const SHAREABLE_ENV_CREDENTIALS = ["GX_API_KEY"] as const;

export function isShareableEnvCredential(name: string): boolean {
  return (SHAREABLE_ENV_CREDENTIALS as readonly string[]).includes(name);
}

function envSecret(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * May `tenantId` use the server env value of credential `name`?
 *   null tenant (system context: global health checks, CLI)  → yes
 *   shareable credential (GX_API_KEY)                          → yes
 *   operator workspace (OPERATOR_EMAILS, cached ≤ 60 s)        → yes
 *   anyone else                                                → no
 */
export async function envCredentialAllowed(db: Executor, tenantId: string | null, name: string): Promise<boolean> {
  if (!tenantId) return true;
  if (isShareableEnvCredential(name)) return true;
  return isOperatorTenant(db, tenantId);
}

/**
 * Resolve a credential: the tenant's stored secret first, then the server env
 * var of the same name — but only where `envCredentialAllowed` permits it.
 * Returns undefined when neither applies. Fails closed if the operator check
 * cannot be made.
 */
export async function resolveSecret(db: Executor, tenantId: string | null, providerKey: string, name: string): Promise<string | undefined> {
  if (tenantId) {
    const own = await getTenantSecret(db, tenantId, providerKey, name);
    if (own !== undefined) return own;
  }
  let allowed = false;
  try {
    allowed = await envCredentialAllowed(db, tenantId, name);
  } catch {
    allowed = !tenantId || isShareableEnvCredential(name);
  }
  return allowed ? envSecret(name) : undefined;
}
