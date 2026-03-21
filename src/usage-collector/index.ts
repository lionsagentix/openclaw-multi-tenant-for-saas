/**
 * Usage collector — polls gateway containers for usage data
 * and feeds it into the billing metering pipeline.
 */

export { createUsageCollector, extractMeterableUsage } from "./usage-collector.js";
export type { UsageCollector } from "./usage-collector.js";
export type { CollectionCycleResult, GatewayUsageSnapshot, UsageCollectorConfig } from "./types.js";
