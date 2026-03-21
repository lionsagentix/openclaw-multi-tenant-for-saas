/**
 * Usage collector — periodically pulls usage data from gateway containers.
 *
 * The collector reads auth-profiles.json (which contains usageStats) from each
 * active tenant's gateway, normalizes the data, and feeds it into the billing
 * metering pipeline via `recordUsage()`.
 *
 * For hybrid tenants, only platform-key usage is metered (tenant BYOK usage
 * is excluded from billing).
 */

import type { AuthProfileStore, ProfileUsageStats } from "../agents/auth-profiles/types.js";
import { recordUsage } from "../billing/usage-metering.js";
import type { ContainerRuntime } from "../control-plane/container-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listTenants } from "../tenants/tenant-store.js";
import type { Tenant, TenantCredentialMode } from "../tenants/types.js";
import type { CollectionCycleResult, UsageCollectorConfig } from "./types.js";

const log = createSubsystemLogger("usage-collector");

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_CONCURRENCY = 10;
const MAX_TENANTS_PER_PAGE = 200;
const AUTH_PROFILES_PATH = "/home/node/.openclaw/agents/main/agent/auth-profiles.json";

/**
 * Create a usage collector that periodically polls gateway containers for usage data.
 *
 * Follows the same factory + interval pattern as `src/control-plane/health-monitor.ts`.
 */
export function createUsageCollector(config: UsageCollectorConfig) {
  const {
    runtime,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    abortSignal,
    concurrency = DEFAULT_CONCURRENCY,
  } = config;

  let intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Tracks the last-seen request count per tenant+profile to compute deltas.
   * Without this, cumulative counters would be re-recorded every cycle.
   */
  const lastSeenCounts = new Map<string, number>();

  /**
   * Start the collection loop.
   * Runs the first cycle immediately, then on the configured interval.
   */
  function startCollector(): void {
    if (intervalId) {
      return; // Already running.
    }

    log.info(
      `Starting usage collector (interval: ${pollIntervalMs / 1000}s, concurrency: ${concurrency})`,
    );

    // Run first cycle immediately (fire-and-forget, errors logged inside).
    void runCollectionCycle().catch((err) => {
      log.error("Initial collection cycle failed:", err instanceof Error ? err.message : err);
    });

    intervalId = setInterval(() => {
      void runCollectionCycle().catch((err) => {
        log.error("Collection cycle failed:", err instanceof Error ? err.message : err);
      });
    }, pollIntervalMs);

    // Respect abort signal for graceful shutdown.
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => stopCollector(), { once: true });
    }
  }

  /**
   * Run a single collection cycle across all active tenants.
   *
   * 1. List all active tenants (paginated for 500+ tenants)
   * 2. Skip BYOK-only tenants (not metered)
   * 3. In batches, read auth-profiles.json from each gateway
   * 4. Parse usageStats, compute delta since last read
   * 5. Normalize and call recordUsage()
   */
  async function runCollectionCycle(date?: string): Promise<CollectionCycleResult> {
    const result: CollectionCycleResult = { collected: 0, failed: 0, skipped: 0 };
    const collectionDate = date ?? new Date().toISOString().split("T")[0];

    // Paginate through all active tenants.
    const allTenants: Tenant[] = [];
    let offset = 0;
    while (true) {
      const page = await listTenants({
        status: "active",
        limit: MAX_TENANTS_PER_PAGE,
        offset,
      });
      allTenants.push(...page.tenants);
      if (allTenants.length >= page.total || page.tenants.length < MAX_TENANTS_PER_PAGE) {
        break;
      }
      offset += MAX_TENANTS_PER_PAGE;
    }

    // Filter to metered tenants (platform or hybrid).
    const meteredTenants = allTenants.filter((t) => {
      if (t.credentialMode === "byok") {
        result.skipped++;
        return false;
      }
      if (!t.gatewayContainerId) {
        result.skipped++;
        return false;
      }
      return true;
    });

    // Process in batches with bounded concurrency.
    for (let i = 0; i < meteredTenants.length; i += concurrency) {
      const batch = meteredTenants.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((tenant) => collectFromGateway(tenant, collectionDate, runtime, lastSeenCounts)),
      );

      for (const settledResult of results) {
        if (settledResult.status === "fulfilled") {
          if (settledResult.value) {
            result.collected++;
          } else {
            result.skipped++;
          }
        } else {
          result.failed++;
          log.warn("Gateway collection failed:", settledResult.reason);
        }
      }
    }

    log.info(
      `Collection cycle complete: ${result.collected} collected, ` +
        `${result.failed} failed, ${result.skipped} skipped`,
    );

    return result;
  }

  /** Stop the collection loop. */
  function stopCollector(): void {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      log.info("Usage collector stopped.");
    }
  }

  return {
    startCollector,
    runCollectionCycle,
    stopCollector,
  };
}

export type UsageCollector = ReturnType<typeof createUsageCollector>;

// ── Internal Helpers ────────────────────────────────────────────

/**
 * Collect usage from a single gateway container.
 * Computes delta since last read to avoid double-counting cumulative counters.
 * Returns true if new usage was recorded, false if no new data.
 */
async function collectFromGateway(
  tenant: Tenant,
  collectionDate: string,
  runtime: ContainerRuntime,
  lastSeenCounts: Map<string, number>,
): Promise<boolean> {
  if (!tenant.gatewayContainerId) {
    return false;
  }

  // Read auth-profiles.json from the gateway.
  const content = await runtime.readGatewayFile(tenant.gatewayContainerId, AUTH_PROFILES_PATH);
  if (!content) {
    log.debug(`No auth-profiles.json found for tenant ${tenant.slug}`);
    return false;
  }

  let store: AuthProfileStore;
  try {
    store = JSON.parse(content) as AuthProfileStore;
  } catch {
    log.warn(`Failed to parse auth-profiles.json for tenant ${tenant.slug}`);
    return false;
  }

  if (!store.usageStats || Object.keys(store.usageStats).length === 0) {
    return false;
  }

  // Extract cumulative usage, respecting credential mode.
  const currentUsage = extractMeterableUsage(store, tenant.credentialMode);
  if (currentUsage.totalRequests === 0) {
    return false;
  }

  // Compute delta since last collection to avoid double-counting.
  const deltaKey = `${tenant.id}:total`;
  const lastSeen = lastSeenCounts.get(deltaKey) ?? 0;
  const deltaRequests = currentUsage.totalRequests - lastSeen;

  // Update the last-seen counter regardless of delta value.
  lastSeenCounts.set(deltaKey, currentUsage.totalRequests);

  if (deltaRequests <= 0) {
    // No new usage since last collection.
    return false;
  }

  // Rough token estimate: ~1000 tokens per request (conservative average).
  // Actual token counts require gateway telemetry (future phase).
  const deltaTokens = deltaRequests * 1000;

  // Record only the delta usage.
  await recordUsage({
    tenantId: tenant.id,
    date: collectionDate,
    provider: currentUsage.primaryProvider,
    totalTokens: deltaTokens,
    inputTokens: Math.floor(deltaTokens * 0.7),
    outputTokens: Math.ceil(deltaTokens * 0.3),
    estimatedCostUsd: 0, // Cost calculated by billing provider based on plan
    messageCount: deltaRequests,
  });

  return true;
}

/**
 * Extract meterable usage from a gateway's auth profile store.
 *
 * For hybrid tenants: only platform profile usage is metered.
 * For platform tenants: all profile usage is metered.
 */
export function extractMeterableUsage(
  store: AuthProfileStore,
  credentialMode: TenantCredentialMode,
): {
  totalRequests: number;
  estimatedTokens: number;
  primaryProvider: string;
} {
  let totalRequests = 0;
  let primaryProvider = "unknown";
  let maxRequests = 0;

  for (const [profileId, stats] of Object.entries(store.usageStats ?? {})) {
    // For hybrid mode, only count platform profiles.
    if (credentialMode === "hybrid" && !profileId.startsWith("platform-")) {
      continue;
    }

    const requests = getRequestCount(stats);
    totalRequests += requests;

    // Determine primary provider (the one with most requests).
    const profile = store.profiles[profileId];
    if (profile && requests > maxRequests) {
      maxRequests = requests;
      primaryProvider = profile.provider;
    }
  }

  // Rough token estimate: ~1000 tokens per request (conservative average).
  // The actual token count would come from gateway telemetry in a future phase.
  const estimatedTokens = totalRequests * 1000;

  return { totalRequests, estimatedTokens, primaryProvider };
}

/**
 * Extract request count from profile usage stats.
 * The usageStats format tracks various counters; we use what's available.
 */
function getRequestCount(stats: ProfileUsageStats): number {
  // errorCount tracks failures; if lastUsed is set, at least 1 request was made.
  // In the absence of a dedicated request counter, we infer from available data.
  if (stats.lastUsed) {
    // At minimum 1 request was made. errorCount gives a lower bound on total attempts.
    return Math.max(1, stats.errorCount ?? 0);
  }
  return 0;
}
