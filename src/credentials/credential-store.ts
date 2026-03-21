/**
 * PostgreSQL-backed credential CRUD operations with AES-256-GCM encryption.
 *
 * All tenant BYOK API keys are encrypted before storage. The database only
 * ever contains ciphertext. Decryption happens on read when syncing credentials
 * to a tenant's gateway auth-profiles.json.
 *
 * Uses the shared connection pool from `src/control-plane/db.ts`.
 */

import { getDb } from "../control-plane/db.js";
import { writeAuditLog } from "../tenants/tenant-store.js";
import type { TenantId } from "../tenants/types.js";
import {
  computeKeyPrefix,
  decryptCredential,
  encryptCredential,
  getEncryptionKey,
} from "./credential-encryption.js";
import type {
  CreateTenantCredentialParams,
  DecryptedCredential,
  RotateTenantCredentialParams,
  TenantCredential,
} from "./types.js";

// ── Row-to-Type Mapping ────────────────────────────────────────

/** Map a database row to a TenantCredential (no plaintext key). */
function rowToTenantCredential(row: Record<string, unknown>): TenantCredential {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    provider: row.provider as string,
    label: (row.label as string) || undefined,
    keyPrefix: row.key_prefix as string,
    createdAt: (row.created_at as Date).toISOString(),
    rotatedAt: row.rotated_at ? (row.rotated_at as Date).toISOString() : undefined,
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : undefined,
  };
}

// ── Create ─────────────────────────────────────────────────────

/**
 * Create a new encrypted credential for a tenant.
 * The plaintext API key is encrypted before storage and never persisted in cleartext.
 * Returns the credential metadata (without plaintext).
 */
export async function createTenantCredential(
  params: CreateTenantCredentialParams,
  actor = "system",
): Promise<TenantCredential> {
  const db = getDb();
  const encryptionKey = getEncryptionKey();

  const { ciphertext, iv, authTag } = encryptCredential(params.apiKey, encryptionKey);
  const keyPrefix = computeKeyPrefix(params.apiKey);

  const result = await db.query(
    `INSERT INTO tenant_credentials (tenant_id, provider, label, encrypted_key, key_prefix, encryption_iv, auth_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [params.tenantId, params.provider, params.label || null, ciphertext, keyPrefix, iv, authTag],
  );

  const credential = rowToTenantCredential(result.rows[0]);

  await writeAuditLog({
    tenantId: params.tenantId,
    actor,
    action: "credential.create",
    resourceType: "credential",
    resourceId: credential.id,
    details: { provider: params.provider, keyPrefix },
  });

  return credential;
}

// ── Read ───────────────────────────────────────────────────────

/** List all active (non-revoked) credentials for a tenant. */
export async function getTenantCredentials(tenantId: TenantId): Promise<TenantCredential[]> {
  const db = getDb();
  const result = await db.query(
    "SELECT * FROM tenant_credentials WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC",
    [tenantId],
  );
  return result.rows.map(rowToTenantCredential);
}

/** Get a single credential by ID. Returns null if not found or revoked. */
export async function getTenantCredential(credentialId: string): Promise<TenantCredential | null> {
  const db = getDb();
  const result = await db.query(
    "SELECT * FROM tenant_credentials WHERE id = $1 AND revoked_at IS NULL",
    [credentialId],
  );
  return result.rows.length > 0 ? rowToTenantCredential(result.rows[0]) : null;
}

/**
 * Fetch and decrypt a single credential.
 * Used internally by credential sync — the plaintext key should never leave the server process.
 */
export async function decryptTenantCredential(
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const db = getDb();
  const encryptionKey = getEncryptionKey();

  const result = await db.query(
    "SELECT * FROM tenant_credentials WHERE id = $1 AND revoked_at IS NULL",
    [credentialId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const plaintext = decryptCredential(
    row.encrypted_key as Buffer,
    row.encryption_iv as Buffer,
    row.auth_tag as Buffer,
    encryptionKey,
  );

  return {
    credential: rowToTenantCredential(row),
    plaintext,
  };
}

/**
 * Fetch and decrypt all active credentials for a tenant.
 * Used by credential sync to build the gateway's auth-profiles.json.
 */
export async function decryptAllTenantCredentials(
  tenantId: TenantId,
): Promise<DecryptedCredential[]> {
  const db = getDb();
  const encryptionKey = getEncryptionKey();

  const result = await db.query(
    "SELECT * FROM tenant_credentials WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC",
    [tenantId],
  );

  return result.rows.map((row) => {
    const plaintext = decryptCredential(
      row.encrypted_key as Buffer,
      row.encryption_iv as Buffer,
      row.auth_tag as Buffer,
      encryptionKey,
    );
    return {
      credential: rowToTenantCredential(row),
      plaintext,
    };
  });
}

// ── Delete (soft) ──────────────────────────────────────────────

/**
 * Soft-delete a credential by setting `revoked_at`.
 * Returns the revoked credential, or null if not found.
 */
export async function deleteTenantCredential(
  credentialId: string,
  actor = "system",
): Promise<TenantCredential | null> {
  const db = getDb();

  const result = await db.query(
    `UPDATE tenant_credentials
     SET revoked_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING *`,
    [credentialId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const credential = rowToTenantCredential(result.rows[0]);

  await writeAuditLog({
    tenantId: credential.tenantId,
    actor,
    action: "credential.delete",
    resourceType: "credential",
    resourceId: credential.id,
    details: { provider: credential.provider, keyPrefix: credential.keyPrefix },
  });

  return credential;
}

// ── Rotate ─────────────────────────────────────────────────────

/**
 * Rotate a credential's API key: re-encrypt with the new key, update prefix and timestamp.
 * Returns the updated credential, or null if not found.
 */
export async function rotateTenantCredential(
  params: RotateTenantCredentialParams,
  actor = "system",
): Promise<TenantCredential | null> {
  const db = getDb();
  const encryptionKey = getEncryptionKey();

  const { ciphertext, iv, authTag } = encryptCredential(params.newApiKey, encryptionKey);
  const keyPrefix = computeKeyPrefix(params.newApiKey);

  const result = await db.query(
    `UPDATE tenant_credentials
     SET encrypted_key = $2, encryption_iv = $3, auth_tag = $4, key_prefix = $5, rotated_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING *`,
    [params.credentialId, ciphertext, iv, authTag, keyPrefix],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const credential = rowToTenantCredential(result.rows[0]);

  await writeAuditLog({
    tenantId: credential.tenantId,
    actor,
    action: "credential.rotate",
    resourceType: "credential",
    resourceId: credential.id,
    details: { provider: credential.provider, newKeyPrefix: keyPrefix },
  });

  return credential;
}
