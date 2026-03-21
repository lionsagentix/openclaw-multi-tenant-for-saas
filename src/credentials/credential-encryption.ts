/**
 * AES-256-GCM encryption/decryption for tenant BYOK API keys.
 *
 * All tenant-provided credentials are encrypted before storage in PostgreSQL.
 * The database only ever sees ciphertext. Decryption happens in the application
 * layer when syncing credentials to a tenant's gateway auth-profiles.json.
 *
 * Encryption key is read from the OPENCLAW_CREDENTIAL_ENCRYPTION_KEY env var
 * (a 64-character hex string = 32 bytes for AES-256).
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12 bytes is the recommended IV length for GCM.
const AUTH_TAG_LENGTH = 16; // 16 bytes (128 bits) for GCM auth tag.
const ENV_KEY_NAME = "OPENCLAW_CREDENTIAL_ENCRYPTION_KEY";

export type EncryptedPayload = {
  /** AES-256-GCM ciphertext. */
  ciphertext: Buffer;
  /** 12-byte initialization vector (unique per encryption). */
  iv: Buffer;
  /** 16-byte GCM authentication tag. */
  authTag: Buffer;
};

/**
 * Read and validate the encryption key from the environment.
 * Throws a descriptive error if missing or malformed.
 */
export function getEncryptionKey(): Buffer {
  const hexKey = process.env[ENV_KEY_NAME];
  if (!hexKey) {
    throw new Error(
      `Missing ${ENV_KEY_NAME} environment variable. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(
      `${ENV_KEY_NAME} must be a 64-character hex string (32 bytes). Got ${hexKey.length} characters.`,
    );
  }

  return Buffer.from(hexKey, "hex");
}

/**
 * Encrypt a plaintext credential using AES-256-GCM.
 * Returns ciphertext, IV, and auth tag — all stored separately in the database.
 */
export function encryptCredential(plaintext: string, encryptionKey: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext: encrypted, iv, authTag };
}

/**
 * Decrypt a credential using AES-256-GCM.
 * Throws if the auth tag verification fails (tampered ciphertext).
 */
export function decryptCredential(
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  encryptionKey: Buffer,
): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Extract a safe display prefix from an API key.
 * Returns the first 8 characters (e.g., "sk-proj-" for OpenAI keys).
 */
export function computeKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 8);
}
