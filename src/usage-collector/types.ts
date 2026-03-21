/**
 * Types for the usage collector module.
 *
 * The collector periodically polls gateway containers for usage statistics
 * and feeds them into the billing metering pipeline.
 */

import type { ContainerRuntime } from "../control-plane/container-runtime.js";

/** Configuration for the usage collector. */
export type UsageCollectorConfig = {
  /** Container runtime for reading files from gateway containers. */
  runtime: ContainerRuntime;
  /** Polling interval in milliseconds. Default: 5 minutes. */
  pollIntervalMs?: number;
  /** AbortSignal for graceful shutdown. */
  abortSignal?: AbortSignal;
  /** Max concurrent gateway reads per collection cycle. Default: 10. */
  concurrency?: number;
};

/** Raw usage snapshot read from a gateway's auth-profiles.json usageStats. */
export type GatewayUsageSnapshot = {
  tenantId: string;
  /** Per-profile usage statistics from auth-profiles.json. */
  profiles: Record<
    string,
    {
      provider: string;
      lastUsed?: number;
      /** Total requests served by this profile (if tracked). */
      totalRequests?: number;
    }
  >;
  /** ISO timestamp of when the snapshot was collected. */
  collectedAt: string;
};

/** Result of a single collection cycle. */
export type CollectionCycleResult = {
  /** Number of tenants successfully collected. */
  collected: number;
  /** Number of tenants that failed collection. */
  failed: number;
  /** Number of tenants skipped (BYOK-only or no gateway). */
  skipped: number;
};
