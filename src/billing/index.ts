/**
 * Billing module — payment-provider-agnostic billing for the multi-tenant platform.
 *
 * Re-exports all public types, store functions, provider interface/registry,
 * lifecycle factory, quota enforcement, usage metering, and webhook handler.
 */

// Types.
export type {
  BillingCustomer,
  BillingInvoice,
  BillingInvoiceLineItem,
  BillingProviderName,
  BillingStatus,
  BillingSubscription,
  BillingSubscriptionStatus,
  BillingWebhookEvent,
  CancelSubscriptionParams,
  CreateBillingCustomerParams,
  CreateSubscriptionParams,
  DailyUsage,
  ListInvoicesParams,
  QuotaCheckParams,
  QuotaCheckResult,
  QuotaId,
  QuotaStatus,
  RateLimitBucket,
  RecordUsageParams,
  UsageRecord,
  UsageReportParams,
  UsageSummary,
  WebhookEventType,
} from "./types.js";
export { DEFAULT_BILLING_PROVIDER, WEBHOOK_SIGNATURE_HEADERS } from "./types.js";

// Store.
export {
  createBillingCustomer,
  getBillingCustomer,
  getBillingCustomerByExternalId,
  deleteBillingCustomer,
  createBillingSubscription,
  getBillingSubscription,
  getActiveBillingSubscription,
  updateBillingSubscription,
  listBillingSubscriptions,
  insertUsageRecord,
  getUsageSummary,
  getDailyUsage,
  incrementQuotaBucket,
  getQuotaBucketValue,
  cleanupOldBuckets,
  hasProcessedWebhookEvent,
} from "./billing-store.js";

// Provider interface + registry.
export type { BillingProvider } from "./billing-provider.js";
export {
  registerBillingProvider,
  getBillingProvider,
  getProviderForTenant,
  getRegisteredProviders,
  clearProviderRegistry,
} from "./billing-provider.js";

// Providers.
export { createStripeProvider } from "./providers/stripe.js";
export type { StripeProviderConfig } from "./providers/stripe.js";
export { createPaddleProvider } from "./providers/paddle.js";
export { createLemonSqueezyProvider } from "./providers/lemonsqueezy.js";

// Quota enforcement.
export { checkAndIncrementQuota, checkQuota, getQuotaStatus } from "./quota-enforcement.js";

// Usage metering.
export {
  recordUsage,
  aggregateAndReportUsage,
  runUsageReportingCycle,
  getUsageSummaryForTenant,
} from "./usage-metering.js";

// Webhook handler.
export { createWebhookHandler } from "./webhook-handler.js";
export type { WebhookHandlerConfig } from "./webhook-handler.js";

// Billing lifecycle.
export { createBillingLifecycle } from "./billing-lifecycle.js";
export type { BillingLifecycle, BillingLifecycleConfig } from "./billing-lifecycle.js";
