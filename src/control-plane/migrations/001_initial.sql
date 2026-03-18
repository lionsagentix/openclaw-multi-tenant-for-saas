-- 001_initial.sql
-- Initial schema for the OpenClaw Multi-Tenant Control Plane.
--
-- Tables:
--   tenants            - Core tenant records
--   tenant_quotas      - Per-tenant plan quotas
--   api_keys           - Control plane API keys (admin + tenant-scoped)
--   billing_customers  - Maps tenants to payment provider customers
--   billing_subscriptions - Subscription state
--   usage_records      - Time-series AI usage data (partitioned by month)
--   rate_limit_buckets - Persistent rate limit state
--   audit_log          - Admin audit trail

BEGIN;

-- ── Extensions ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- ── Tenants ────────────────────────────────────────────────────
CREATE TABLE tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                VARCHAR(64) UNIQUE NOT NULL,
  display_name        VARCHAR(255) NOT NULL,
  status              VARCHAR(32) NOT NULL DEFAULT 'provisioning'
                        CHECK (status IN ('provisioning', 'active', 'suspended', 'deprovisioning', 'deleted')),
  plan                VARCHAR(32) NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  credential_mode     VARCHAR(16) NOT NULL DEFAULT 'platform'
                        CHECK (credential_mode IN ('platform', 'byok', 'hybrid')),
  contact_email       VARCHAR(255) NOT NULL,
  gateway_container_id VARCHAR(255),
  gateway_port        INTEGER,
  gateway_host        VARCHAR(255),
  activity_state      VARCHAR(32) NOT NULL DEFAULT 'active'
                        CHECK (activity_state IN ('active', 'idle', 'hibernated', 'waking')),
  last_activity_at    TIMESTAMPTZ,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at        TIMESTAMPTZ,
  suspended_reason    TEXT,
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_status ON tenants (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_plan ON tenants (plan) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_activity_state ON tenants (activity_state) WHERE status = 'active';

-- ── Tenant Quotas ──────────────────────────────────────────────
CREATE TABLE tenant_quotas (
  tenant_id               UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_agents              INTEGER NOT NULL DEFAULT 3,
  max_sessions_per_agent  INTEGER NOT NULL DEFAULT 100,
  max_messages_per_day    INTEGER NOT NULL DEFAULT 1000,
  max_tokens_per_day      BIGINT NOT NULL DEFAULT 1000000,
  max_cost_per_day_cents  INTEGER NOT NULL DEFAULT 1000,
  max_cost_per_month_cents INTEGER NOT NULL DEFAULT 10000,
  max_channels            INTEGER NOT NULL DEFAULT 3,
  max_storage_bytes       BIGINT NOT NULL DEFAULT 1073741824  -- 1 GB
);

-- ── API Keys ───────────────────────────────────────────────────
-- Used for control plane authentication (admin keys + tenant-scoped keys).
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  -- key_hash: SHA-256 hash of the full API key. Never store plaintext keys.
  key_hash        VARCHAR(128) NOT NULL UNIQUE,
  -- key_prefix: first 8 chars for identification in logs/UI (e.g., "oc_live_a1b2c3d4").
  key_prefix      VARCHAR(16) NOT NULL,
  -- scope: "admin" for platform-wide access, "tenant" for tenant-scoped access.
  scope           VARCHAR(32) NOT NULL CHECK (scope IN ('admin', 'tenant')),
  label           VARCHAR(255),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_prefix ON api_keys (key_prefix);

-- ── Billing Customers ──────────────────────────────────────────
-- Maps tenants to external payment provider customers.
-- Payment-provider-agnostic: provider column identifies which implementation to use.
CREATE TABLE billing_customers (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider              VARCHAR(32) NOT NULL,  -- "stripe" | "paddle" | "lemonsqueezy"
  external_customer_id  VARCHAR(255) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Billing Subscriptions ──────────────────────────────────────
CREATE TABLE billing_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                VARCHAR(32) NOT NULL,
  external_subscription_id VARCHAR(255) NOT NULL,
  plan_id                 VARCHAR(64) NOT NULL,
  status                  VARCHAR(32) NOT NULL
                            CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')),
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_subscriptions_tenant ON billing_subscriptions (tenant_id);
CREATE INDEX idx_billing_subscriptions_status ON billing_subscriptions (status);

-- ── Usage Records ──────────────────────────────────────────────
-- Time-series table for AI usage tracking. Partitioned by month for performance.
CREATE TABLE usage_records (
  id                  BIGSERIAL,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id            VARCHAR(128),
  date                DATE NOT NULL,
  provider            VARCHAR(64),
  model               VARCHAR(128),
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,
  message_count       INTEGER NOT NULL DEFAULT 0,
  collected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, date)
) PARTITION BY RANGE (date);

-- Create partitions for the current and next 3 months.
-- In production, add a cron job or control plane task to create future partitions.
DO $$
DECLARE
  month_start DATE;
  month_end DATE;
  partition_name TEXT;
BEGIN
  FOR i IN 0..3 LOOP
    month_start := DATE_TRUNC('month', CURRENT_DATE) + (i || ' months')::INTERVAL;
    month_end := month_start + '1 month'::INTERVAL;
    partition_name := 'usage_records_' || TO_CHAR(month_start, 'YYYY_MM');

    EXECUTE FORMAT(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, month_end
    );
  END LOOP;
END $$;

CREATE INDEX idx_usage_records_tenant_date ON usage_records (tenant_id, date);
CREATE INDEX idx_usage_records_date ON usage_records (date);

-- ── Rate Limit Buckets ─────────────────────────────────────────
-- Persistent rate limit state for quota enforcement.
-- Each bucket tracks usage within a time window for a specific quota type.
CREATE TABLE rate_limit_buckets (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quota_id      VARCHAR(64) NOT NULL,   -- "messages_per_day" | "tokens_per_day" | "cost_per_day" | "cost_per_month"
  window_start  TIMESTAMPTZ NOT NULL,
  current_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, quota_id, window_start)
);

-- Auto-cleanup old rate limit windows (older than 90 days).
CREATE INDEX idx_rate_limit_buckets_cleanup ON rate_limit_buckets (window_start);

-- ── Audit Log ──────────────────────────────────────────────────
-- Immutable audit trail for all tenant management operations.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor         VARCHAR(255) NOT NULL,    -- API key prefix or "system"
  action        VARCHAR(128) NOT NULL,    -- "tenant.create" | "tenant.suspend" | "billing.webhook" | etc.
  resource_type VARCHAR(64),              -- "tenant" | "subscription" | "api_key" | etc.
  resource_id   VARCHAR(255),             -- ID of the affected resource
  details       JSONB,                    -- Additional context (request body, old/new values, etc.)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_tenant ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON audit_log (action, created_at DESC);
CREATE INDEX idx_audit_log_created ON audit_log (created_at DESC);

-- ── Updated-at trigger ─────────────────────────────────────────
-- Auto-update `updated_at` on tenant row changes.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER billing_subscriptions_updated_at
  BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
