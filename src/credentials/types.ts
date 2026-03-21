/**
 * Types for the tenant credential management system (BYOK).
 *
 * Tenants can upload their own AI provider API keys, which are stored
 * encrypted at rest and synced to the gateway's auth-profiles.json.
 */

import type { TenantId } from "../tenants/types.js";

/** A tenant credential record (never contains the plaintext key). */
export type TenantCredential = {
  /** UUID primary key. */
  id: string;
  /** Owning tenant. */
  tenantId: TenantId;
  /** AI provider identifier (e.g., "openai", "anthropic", "google"). */
  provider: string;
  /** Human-friendly label (e.g., "Production OpenAI Key"). */
  label?: string;
  /** First 8 characters of the API key for safe UI display. */
  keyPrefix: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last rotation (if rotated). */
  rotatedAt?: string;
  /** ISO timestamp of revocation (if revoked/deleted). */
  revokedAt?: string;
};

/** Parameters for creating a new tenant credential. */
export type CreateTenantCredentialParams = {
  /** Tenant who owns this credential. */
  tenantId: TenantId;
  /** AI provider (e.g., "openai", "anthropic"). */
  provider: string;
  /** Plaintext API key — encrypted before storage, never persisted in cleartext. */
  apiKey: string;
  /** Optional human-friendly label. */
  label?: string;
};

/** Parameters for rotating an existing credential's key. */
export type RotateTenantCredentialParams = {
  /** ID of the credential to rotate. */
  credentialId: string;
  /** New plaintext API key — replaces the old encrypted key. */
  newApiKey: string;
};

/** A decrypted credential (only used internally by credential sync). */
export type DecryptedCredential = {
  /** The credential metadata (no plaintext). */
  credential: TenantCredential;
  /** The decrypted plaintext API key. */
  plaintext: string;
};

/** Supported AI provider identifiers for BYOK credentials. */
export type ByokProvider = "openai" | "anthropic" | "google" | "azure-openai";

/** Well-known BYOK providers (for validation, not an exhaustive list). */
export const KNOWN_BYOK_PROVIDERS: ReadonlySet<string> = new Set<string>([
  "openai",
  "anthropic",
  "google",
  "azure-openai",
]);
