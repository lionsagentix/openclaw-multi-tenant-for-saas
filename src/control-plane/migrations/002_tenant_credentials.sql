-- 002_tenant_credentials.sql
-- Adds encrypted credential storage for tenant BYOK (Bring Your Own Key) API keys.
--
-- Credentials are encrypted at rest using AES-256-GCM in the application layer.
-- The database only stores ciphertext, IV, and auth tag — never plaintext keys.

BEGIN;

CREATE TABLE tenant_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- AI provider: "openai" | "anthropic" | "google" | "azure-openai" | etc.
  provider        VARCHAR(64) NOT NULL,
  -- Human-friendly label (e.g., "Production OpenAI Key")
  label           VARCHAR(255),
  -- AES-256-GCM encrypted API key (ciphertext only).
  encrypted_key   BYTEA NOT NULL,
  -- First 8 characters of the plaintext key for safe UI display (e.g., "sk-proj-a").
  key_prefix      VARCHAR(16) NOT NULL,
  -- 12-byte initialization vector (unique per encryption operation).
  encryption_iv   BYTEA NOT NULL,
  -- 16-byte GCM authentication tag (integrity verification).
  auth_tag        BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the key is rotated (old ciphertext replaced with new).
  rotated_at      TIMESTAMPTZ,
  -- Soft-delete: set when the credential is revoked/removed.
  revoked_at      TIMESTAMPTZ
);

-- Active credentials for a tenant (most common query path).
CREATE INDEX idx_tenant_credentials_tenant
  ON tenant_credentials (tenant_id)
  WHERE revoked_at IS NULL;

-- Active credentials filtered by provider (for credential sync).
CREATE INDEX idx_tenant_credentials_provider
  ON tenant_credentials (tenant_id, provider)
  WHERE revoked_at IS NULL;

COMMIT;
