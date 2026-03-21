/**
 * Real-time quota enforcement using rate_limit_buckets.
 *
 * Provides atomic check-and-increment for per-tenant usage quotas.
 * Window calculation uses UTC day/month boundaries.
 */

import { getTenantQuotas } from "../tenants/tenant-store.js";
import { getQuotaBucketValue, incrementQuotaBucket } from "./billing-store.js";
import type { QuotaCheckParams, QuotaCheckResult, QuotaId, QuotaStatus } from "./types.js";

// ── Window Calculation ─────────────────────────────────────────

/** Compute the window start for a quota bucket. */
function getWindowStart(quotaId: QuotaId): string {
  const now = new Date();

  if (quotaId === "cost_per_month") {
    // Start of current month in UTC.
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }

  // Daily quotas: start of current day in UTC.
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** Map quota IDs to the corresponding tenant quota field. */
function getQuotaLimit(
  quotas: {
    maxMessagesPerDay: number;
    maxTokensPerDay: number;
    maxCostPerDayCents: number;
    maxCostPerMonthCents: number;
  },
  quotaId: QuotaId,
): number {
  switch (quotaId) {
    case "messages_per_day":
      return quotas.maxMessagesPerDay;
    case "tokens_per_day":
      return quotas.maxTokensPerDay;
    case "cost_per_day":
      return quotas.maxCostPerDayCents;
    case "cost_per_month":
      return quotas.maxCostPerMonthCents;
  }
}

// ── Quota Enforcement ──────────────────────────────────────────

/**
 * Atomically check and increment a quota bucket.
 *
 * If the increment would exceed the tenant's limit, the write is not applied
 * and `allowed: false` is returned. Otherwise the bucket is incremented and
 * `allowed: true` is returned with the new value.
 */
export async function checkAndIncrementQuota(params: QuotaCheckParams): Promise<QuotaCheckResult> {
  const quotas = await getTenantQuotas(params.tenantId);
  if (!quotas) {
    // No quotas configured — deny by default.
    return {
      allowed: false,
      quotaId: params.quotaId,
      currentValue: 0,
      limit: 0,
    };
  }

  const limit = getQuotaLimit(quotas, params.quotaId);
  const windowStart = getWindowStart(params.quotaId);

  const result = await incrementQuotaBucket({
    tenantId: params.tenantId,
    quotaId: params.quotaId,
    windowStart,
    increment: params.increment,
    limit,
  });

  if (!result) {
    // Quota exceeded — get the current value for the response.
    const currentValue = await getQuotaBucketValue(params.tenantId, params.quotaId, windowStart);

    return {
      allowed: false,
      quotaId: params.quotaId,
      currentValue,
      limit,
    };
  }

  return {
    allowed: true,
    quotaId: params.quotaId,
    currentValue: result.newValue,
    limit,
  };
}

/**
 * Read-only quota check (does not increment).
 *
 * Returns the current usage vs. limit for a specific quota.
 */
export async function checkQuota(tenantId: string, quotaId: QuotaId): Promise<QuotaCheckResult> {
  const quotas = await getTenantQuotas(tenantId);
  if (!quotas) {
    return { allowed: false, quotaId, currentValue: 0, limit: 0 };
  }

  const limit = getQuotaLimit(quotas, quotaId);
  const windowStart = getWindowStart(quotaId);
  const currentValue = await getQuotaBucketValue(tenantId, quotaId, windowStart);

  return {
    allowed: currentValue < limit,
    quotaId,
    currentValue,
    limit,
  };
}

/**
 * Get quota status for all quota types (for tenant dashboard).
 *
 * Returns the current usage, limit, and percentage for each quota.
 */
export async function getQuotaStatus(tenantId: string): Promise<QuotaStatus[]> {
  const quotas = await getTenantQuotas(tenantId);
  if (!quotas) {
    return [];
  }

  const quotaIds: QuotaId[] = [
    "messages_per_day",
    "tokens_per_day",
    "cost_per_day",
    "cost_per_month",
  ];

  const results = await Promise.all(
    quotaIds.map(async (quotaId) => {
      const limit = getQuotaLimit(quotas, quotaId);
      const windowStart = getWindowStart(quotaId);
      const currentValue = await getQuotaBucketValue(tenantId, quotaId, windowStart);

      return {
        quotaId,
        currentValue,
        limit,
        percentUsed: limit > 0 ? Math.round((currentValue / limit) * 100) : 0,
      };
    }),
  );

  return results;
}
