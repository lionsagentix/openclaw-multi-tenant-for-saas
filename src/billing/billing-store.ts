/**
 * PostgreSQL-backed billing CRUD operations.
 *
 * All database access for billing records goes through this module.
 * Uses the shared connection pool from `src/control-plane/db.ts`.
 */

import { getDb } from "../control-plane/db.js";
import type {
  BillingCustomer,
  BillingProviderName,
  BillingSubscription,
  BillingSubscriptionStatus,
  CreateBillingCustomerParams,
  DailyUsage,
  QuotaId,
  RateLimitBucket,
  RecordUsageParams,
  UsageRecord,
  UsageSummary,
} from "./types.js";

// ── Row-to-Type Mapping ────────────────────────────────────────

function rowToBillingCustomer(row: Record<string, unknown>): BillingCustomer {
  return {
    tenantId: row.tenant_id as string,
    provider: row.provider as BillingProviderName,
    externalCustomerId: row.external_customer_id as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function rowToBillingSubscription(row: Record<string, unknown>): BillingSubscription {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    provider: row.provider as BillingProviderName,
    externalSubscriptionId: row.external_subscription_id as string,
    planId: row.plan_id as string,
    status: row.status as BillingSubscriptionStatus,
    currentPeriodStart: row.current_period_start
      ? (row.current_period_start as Date).toISOString()
      : undefined,
    currentPeriodEnd: row.current_period_end
      ? (row.current_period_end as Date).toISOString()
      : undefined,
    cancelAtPeriodEnd: (row.cancel_at_period_end as boolean) ?? false,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function rowToUsageRecord(row: Record<string, unknown>): UsageRecord {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id as string,
    agentId: (row.agent_id as string) || undefined,
    date: row.date instanceof Date ? row.date.toISOString().split("T")[0] : (row.date as string),
    provider: (row.provider as string) || undefined,
    model: (row.model as string) || undefined,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    totalTokens: Number(row.total_tokens),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    messageCount: Number(row.message_count),
    collectedAt: (row.collected_at as Date).toISOString(),
  };
}

function _rowToRateLimitBucket(row: Record<string, unknown>): RateLimitBucket {
  return {
    tenantId: row.tenant_id as string,
    quotaId: row.quota_id as QuotaId,
    windowStart: (row.window_start as Date).toISOString(),
    currentValue: Number(row.current_value),
  };
}

// ── Customer Operations ────────────────────────────────────────

/** Create a billing customer record linking tenant to external provider. */
export async function createBillingCustomer(
  params: CreateBillingCustomerParams,
): Promise<BillingCustomer> {
  const db = getDb();
  const result = await db.query(
    `INSERT INTO billing_customers (tenant_id, provider, external_customer_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.tenantId, params.provider, params.externalCustomerId],
  );
  return rowToBillingCustomer(result.rows[0]);
}

/** Get billing customer by tenant ID. */
export async function getBillingCustomer(tenantId: string): Promise<BillingCustomer | null> {
  const db = getDb();
  const result = await db.query("SELECT * FROM billing_customers WHERE tenant_id = $1", [tenantId]);
  return result.rows.length > 0 ? rowToBillingCustomer(result.rows[0]) : null;
}

/** Get billing customer by external provider customer ID. */
export async function getBillingCustomerByExternalId(
  provider: BillingProviderName,
  externalCustomerId: string,
): Promise<BillingCustomer | null> {
  const db = getDb();
  const result = await db.query(
    "SELECT * FROM billing_customers WHERE provider = $1 AND external_customer_id = $2",
    [provider, externalCustomerId],
  );
  return result.rows.length > 0 ? rowToBillingCustomer(result.rows[0]) : null;
}

/** Delete a billing customer record. */
export async function deleteBillingCustomer(tenantId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.query("DELETE FROM billing_customers WHERE tenant_id = $1", [tenantId]);
  return (result.rowCount ?? 0) > 0;
}

// ── Subscription Operations ────────────────────────────────────

/** Create a billing subscription record. */
export async function createBillingSubscription(params: {
  tenantId: string;
  provider: BillingProviderName;
  externalSubscriptionId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
}): Promise<BillingSubscription> {
  const db = getDb();
  const result = await db.query(
    `INSERT INTO billing_subscriptions
     (tenant_id, provider, external_subscription_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.tenantId,
      params.provider,
      params.externalSubscriptionId,
      params.planId,
      params.status,
      params.currentPeriodStart || null,
      params.currentPeriodEnd || null,
    ],
  );
  return rowToBillingSubscription(result.rows[0]);
}

/** Get a subscription by ID. */
export async function getBillingSubscription(id: string): Promise<BillingSubscription | null> {
  const db = getDb();
  const result = await db.query("SELECT * FROM billing_subscriptions WHERE id = $1", [id]);
  return result.rows.length > 0 ? rowToBillingSubscription(result.rows[0]) : null;
}

/** Get the active subscription for a tenant. */
export async function getActiveBillingSubscription(
  tenantId: string,
): Promise<BillingSubscription | null> {
  const db = getDb();
  const result = await db.query(
    `SELECT * FROM billing_subscriptions
     WHERE tenant_id = $1 AND status IN ('active', 'trialing')
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId],
  );
  return result.rows.length > 0 ? rowToBillingSubscription(result.rows[0]) : null;
}

/** Update a billing subscription. Only provided fields are updated. */
export async function updateBillingSubscription(
  id: string,
  updates: Partial<
    Pick<
      BillingSubscription,
      | "status"
      | "planId"
      | "externalSubscriptionId"
      | "currentPeriodStart"
      | "currentPeriodEnd"
      | "cancelAtPeriodEnd"
    >
  >,
): Promise<BillingSubscription | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.planId !== undefined) {
    setClauses.push(`plan_id = $${paramIndex++}`);
    values.push(updates.planId);
  }
  if (updates.externalSubscriptionId !== undefined) {
    setClauses.push(`external_subscription_id = $${paramIndex++}`);
    values.push(updates.externalSubscriptionId);
  }
  if (updates.currentPeriodStart !== undefined) {
    setClauses.push(`current_period_start = $${paramIndex++}`);
    values.push(updates.currentPeriodStart);
  }
  if (updates.currentPeriodEnd !== undefined) {
    setClauses.push(`current_period_end = $${paramIndex++}`);
    values.push(updates.currentPeriodEnd);
  }
  if (updates.cancelAtPeriodEnd !== undefined) {
    setClauses.push(`cancel_at_period_end = $${paramIndex++}`);
    values.push(updates.cancelAtPeriodEnd);
  }

  if (setClauses.length === 0) {
    return getBillingSubscription(id);
  }

  values.push(id);
  const db = getDb();
  const result = await db.query(
    `UPDATE billing_subscriptions SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result.rows.length > 0 ? rowToBillingSubscription(result.rows[0]) : null;
}

/** List all subscriptions for a tenant, ordered by creation date. */
export async function listBillingSubscriptions(tenantId: string): Promise<BillingSubscription[]> {
  const db = getDb();
  const result = await db.query(
    "SELECT * FROM billing_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC",
    [tenantId],
  );
  return result.rows.map(rowToBillingSubscription);
}

// ── Usage Operations ───────────────────────────────────────────

/** Insert a usage record. */
export async function insertUsageRecord(params: RecordUsageParams): Promise<UsageRecord> {
  const db = getDb();
  const result = await db.query(
    `INSERT INTO usage_records
     (tenant_id, agent_id, date, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, estimated_cost_usd, message_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      params.tenantId,
      params.agentId || null,
      params.date,
      params.provider || null,
      params.model || null,
      params.inputTokens,
      params.outputTokens,
      params.cacheReadTokens ?? 0,
      params.cacheWriteTokens ?? 0,
      params.totalTokens,
      params.estimatedCostUsd,
      params.messageCount,
    ],
  );
  return rowToUsageRecord(result.rows[0]);
}

/** Get aggregated usage summary for a tenant over a date range. */
export async function getUsageSummary(
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<UsageSummary> {
  const db = getDb();
  const result = await db.query(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
       COALESCE(SUM(message_count), 0) AS total_messages
     FROM usage_records
     WHERE tenant_id = $1 AND date >= $2 AND date <= $3`,
    [tenantId, startDate, endDate],
  );

  const row = result.rows[0];
  return {
    tenantId,
    startDate,
    endDate,
    totalInputTokens: Number(row.total_input_tokens),
    totalOutputTokens: Number(row.total_output_tokens),
    totalCacheReadTokens: Number(row.total_cache_read_tokens),
    totalCacheWriteTokens: Number(row.total_cache_write_tokens),
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    totalMessages: Number(row.total_messages),
  };
}

/** Get detailed daily usage breakdown for a tenant on a specific date. */
export async function getDailyUsage(tenantId: string, date: string): Promise<DailyUsage> {
  const db = getDb();

  // Aggregated totals for the day.
  const totalsResult = await db.query(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
       COALESCE(SUM(message_count), 0) AS total_messages
     FROM usage_records
     WHERE tenant_id = $1 AND date = $2`,
    [tenantId, date],
  );

  // Breakdown by model.
  const byModelResult = await db.query(
    `SELECT
       COALESCE(provider, 'unknown') AS provider,
       COALESCE(model, 'unknown') AS model,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(total_tokens) AS total_tokens,
       SUM(estimated_cost_usd) AS estimated_cost_usd,
       SUM(message_count) AS message_count
     FROM usage_records
     WHERE tenant_id = $1 AND date = $2
     GROUP BY provider, model
     ORDER BY SUM(total_tokens) DESC`,
    [tenantId, date],
  );

  const totals = totalsResult.rows[0];
  return {
    date,
    totalInputTokens: Number(totals.total_input_tokens),
    totalOutputTokens: Number(totals.total_output_tokens),
    totalTokens: Number(totals.total_tokens),
    totalCostUsd: Number(totals.total_cost_usd),
    totalMessages: Number(totals.total_messages),
    byModel: byModelResult.rows.map((row) => ({
      provider: row.provider as string,
      model: row.model as string,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
      messageCount: Number(row.message_count),
    })),
  };
}

// ── Rate Limit Operations (Atomic) ─────────────────────────────

/**
 * Atomically increment a quota bucket. Returns the new value if the increment
 * was within limits, or null if the quota would be exceeded (no write occurs).
 *
 * Uses an atomic CTE: INSERT ... ON CONFLICT DO UPDATE SET current_value =
 * current_value + $inc WHERE current_value + $inc <= $limit.
 */
export async function incrementQuotaBucket(params: {
  tenantId: string;
  quotaId: QuotaId;
  windowStart: string;
  increment: number;
  limit: number;
}): Promise<{ newValue: number } | null> {
  const db = getDb();
  const result = await db.query(
    `WITH upsert AS (
       INSERT INTO rate_limit_buckets (tenant_id, quota_id, window_start, current_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, quota_id, window_start)
       DO UPDATE SET current_value = rate_limit_buckets.current_value + $4
       WHERE rate_limit_buckets.current_value + $4 <= $5
       RETURNING current_value
     )
     SELECT current_value FROM upsert`,
    [params.tenantId, params.quotaId, params.windowStart, params.increment, params.limit],
  );

  if (result.rows.length === 0) {
    return null; // Quota exceeded — no write occurred.
  }

  return { newValue: Number(result.rows[0].current_value) };
}

/** Get the current value of a quota bucket. Returns 0 if no bucket exists. */
export async function getQuotaBucketValue(
  tenantId: string,
  quotaId: QuotaId,
  windowStart: string,
): Promise<number> {
  const db = getDb();
  const result = await db.query(
    `SELECT current_value FROM rate_limit_buckets
     WHERE tenant_id = $1 AND quota_id = $2 AND window_start = $3`,
    [tenantId, quotaId, windowStart],
  );
  return result.rows.length > 0 ? Number(result.rows[0].current_value) : 0;
}

/** Delete rate limit buckets older than the given date. */
export async function cleanupOldBuckets(olderThan: string): Promise<number> {
  const db = getDb();
  const result = await db.query("DELETE FROM rate_limit_buckets WHERE window_start < $1", [
    olderThan,
  ]);
  return result.rowCount ?? 0;
}

// ── Webhook Idempotency ────────────────────────────────────────

/**
 * Check if a webhook event has already been processed.
 * Uses the audit_log table with action = 'billing.webhook.processed'.
 */
export async function hasProcessedWebhookEvent(
  eventId: string,
  provider: BillingProviderName,
): Promise<boolean> {
  const db = getDb();
  const result = await db.query(
    `SELECT 1 FROM audit_log
     WHERE action = 'billing.webhook.processed'
       AND resource_type = 'webhook'
       AND resource_id = $1
       AND details->>'provider' = $2
     LIMIT 1`,
    [eventId, provider],
  );
  return result.rows.length > 0;
}
