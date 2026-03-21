/**
 * Usage metering — collection, aggregation, and reporting to billing providers.
 *
 * Records AI usage per tenant, aggregates daily totals, and reports
 * metered usage to the tenant's billing provider. BYOK tenants are skipped
 * since they are not metered by the platform.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getTenant, listTenants } from "../tenants/tenant-store.js";
import { getProviderForTenant } from "./billing-provider.js";
import {
  getActiveBillingSubscription,
  getUsageSummary,
  insertUsageRecord,
} from "./billing-store.js";
import type { RecordUsageParams, UsageSummary } from "./types.js";

const log = createSubsystemLogger("billing/usage-metering");

// ── Usage Recording ────────────────────────────────────────────

/** Record a single usage event for a tenant. */
export async function recordUsage(params: RecordUsageParams): Promise<void> {
  await insertUsageRecord(params);
  log.debug(`Recorded usage for tenant ${params.tenantId}: ${params.totalTokens} tokens`);
}

// ── Usage Aggregation + Reporting ──────────────────────────────

/**
 * Aggregate a tenant's daily usage and report it to their billing provider.
 *
 * Skips BYOK tenants (not metered by the platform).
 * Reports the total token count as the metered quantity.
 */
export async function aggregateAndReportUsage(tenantId: string, date?: string): Promise<void> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    log.warn(`Tenant ${tenantId} not found, skipping usage report.`);
    return;
  }

  // BYOK tenants are not metered by the platform.
  if (tenant.credentialMode === "byok") {
    log.debug(`Skipping BYOK tenant ${tenant.slug}.`);
    return;
  }

  const reportDate = date ?? new Date().toISOString().split("T")[0];
  const summary = await getUsageSummary(tenantId, reportDate, reportDate);

  // Nothing to report if there was no usage.
  if (summary.totalTokens === 0 && summary.totalMessages === 0) {
    log.debug(`No usage to report for tenant ${tenant.slug} on ${reportDate}.`);
    return;
  }

  // Get the active subscription.
  const subscription = await getActiveBillingSubscription(tenantId);
  if (!subscription) {
    log.warn(`No active subscription for tenant ${tenant.slug}, skipping usage report.`);
    return;
  }

  // Report to the billing provider.
  try {
    const provider = await getProviderForTenant(tenantId);
    await provider.reportUsage(subscription.externalSubscriptionId, {
      quantity: summary.totalTokens,
      timestamp: new Date(reportDate).toISOString(),
      action: "ai_token_usage",
    });
    log.info(`Reported ${summary.totalTokens} tokens for tenant ${tenant.slug} on ${reportDate}.`);
  } catch (err) {
    log.error(
      `Failed to report usage for tenant ${tenant.slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

// ── Batch Reporting Cycle ──────────────────────────────────────

const BATCH_SIZE = 10;

/**
 * Run a full usage reporting cycle for all active metered tenants.
 *
 * Iterates through active platform/hybrid tenants in batches,
 * aggregating and reporting each tenant's daily usage.
 */
export async function runUsageReportingCycle(date?: string): Promise<{
  processed: number;
  failed: number;
  skipped: number;
}> {
  const reportDate = date ?? new Date().toISOString().split("T")[0];
  log.info(`Starting usage reporting cycle for ${reportDate}.`);

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let offset = 0;

  while (true) {
    const { tenants, total } = await listTenants({
      status: "active",
      limit: BATCH_SIZE,
      offset,
    });

    if (tenants.length === 0) {
      break;
    }

    // Process batch concurrently.
    const results = await Promise.allSettled(
      tenants.map(async (tenant) => {
        if (tenant.credentialMode === "byok") {
          skipped++;
          return;
        }

        await aggregateAndReportUsage(tenant.id, reportDate);
        processed++;
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failed++;
        log.error(`Batch item failed: ${result.reason}`);
      }
    }

    offset += tenants.length;
    if (offset >= total) {
      break;
    }
  }

  log.info(
    `Usage reporting cycle complete: ${processed} processed, ${failed} failed, ${skipped} skipped.`,
  );
  return { processed, failed, skipped };
}

// ── Dashboard Query ────────────────────────────────────────────

/**
 * Get usage summary for a tenant dashboard.
 * Wraps the store function with date range convenience.
 */
export async function getUsageSummaryForTenant(
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<UsageSummary> {
  return getUsageSummary(tenantId, startDate, endDate);
}
