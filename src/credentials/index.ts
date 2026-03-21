/**
 * Tenant credential management — BYOK (Bring Your Own Key) system.
 *
 * Provides encrypted storage, CRUD operations, and gateway sync
 * for tenant-provided AI provider API keys.
 */

// Types
export type {
  ByokProvider,
  CreateTenantCredentialParams,
  DecryptedCredential,
  RotateTenantCredentialParams,
  TenantCredential,
} from "./types.js";
export { KNOWN_BYOK_PROVIDERS } from "./types.js";

// Encryption
export {
  computeKeyPrefix,
  decryptCredential,
  encryptCredential,
  getEncryptionKey,
} from "./credential-encryption.js";
export type { EncryptedPayload } from "./credential-encryption.js";

// Store (DB CRUD)
export {
  createTenantCredential,
  decryptAllTenantCredentials,
  decryptTenantCredential,
  deleteTenantCredential,
  getTenantCredential,
  getTenantCredentials,
  rotateTenantCredential,
} from "./credential-store.js";

// Sync (gateway auth-profiles)
export { buildAuthProfileStore, createCredentialSync } from "./credential-sync.js";
export type { CredentialSync, CredentialSyncConfig } from "./credential-sync.js";
