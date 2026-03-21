/**
 * Billing domain types for the multi-tenant SaaS platform.
 *
 * Payment-provider-agnostic types that support Stripe, Paddle, and LemonSqueezy.
 * Each tenant can use a different billing provider via `billing_customers.provider`.
 */

import type { TenantId, TenantPlan } from "../tenants/types.js";

// ── Provider Names ─────────────────────────────────────────────

/** Supported billing provider identifiers. */
export type BillingProviderName = "stripe" | "paddle" | "lemonsqueezy";

/** Default provider for new tenants when no provider is explicitly set. */
export const DEFAULT_BILLING_PROVIDER: BillingProviderName = "stripe";

// ── Subscription Status ────────────────────────────────────────

/** Subscription lifecycle states (mirrors DB CHECK constraint). */
export type BillingSubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "unpaid";

// ── Webhook Event Types ────────────────────────────────────────

/** Normalized webhook event types (provider-agnostic). */
export type WebhookEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "customer.deleted";

/** Maps provider name -> HTTP header used for webhook signatures. */
export const WEBHOOK_SIGNATURE_HEADERS: Record<BillingProviderName, string> = {
  stripe: "stripe-signature",
  paddle: "paddle-signature",
  lemonsqueezy: "x-signature",
};

// ── Quota IDs ──────────────────────────────────────────────────

/** Rate limit bucket identifiers (match `rate_limit_buckets.quota_id`). */
export type QuotaId = "messages_per_day" | "tokens_per_day" | "cost_per_day" | "cost_per_month";

// ── Domain Objects ─────────────────────────────────────────────

/** Billing customer record (maps tenant -> external payment provider customer). */
export type BillingCustomer = {
  tenantId: TenantId;
  provider: BillingProviderName;
  externalCustomerId: string;
  createdAt: string;
};

/** Billing subscription record. */
export type BillingSubscription = {
  id: string;
  tenantId: TenantId;
  provider: BillingProviderName;
  externalSubscriptionId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Normalized invoice from payment provider. */
export type BillingInvoice = {
  id: string;
  customerId: string;
  subscriptionId?: string;
  status: string;
  currency: string;
  amountDue: number;
  amountPaid: number;
  lineItems: BillingInvoiceLineItem[];
  periodStart?: string;
  periodEnd?: string;
  createdAt: string;
  paidAt?: string;
  hostedUrl?: string;
};

/** Single line item on an invoice. */
export type BillingInvoiceLineItem = {
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
};

/** Normalized webhook event parsed from any provider. */
export type BillingWebhookEvent = {
  id: string;
  type: WebhookEventType;
  provider: BillingProviderName;
  /** Raw event data from the provider. */
  data: Record<string, unknown>;
  /** ISO timestamp when the event occurred. */
  occurredAt: string;
};

/** Usage record from the `usage_records` table. */
export type UsageRecord = {
  id: number;
  tenantId: TenantId;
  agentId?: string;
  date: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  messageCount: number;
  collectedAt: string;
};

/** Rate limit bucket state from the `rate_limit_buckets` table. */
export type RateLimitBucket = {
  tenantId: TenantId;
  quotaId: QuotaId;
  windowStart: string;
  currentValue: number;
};

/** Result of a quota check or increment operation. */
export type QuotaCheckResult = {
  allowed: boolean;
  quotaId: QuotaId;
  currentValue: number;
  limit: number;
};

/** Per-quota status for dashboard display. */
export type QuotaStatus = {
  quotaId: QuotaId;
  currentValue: number;
  limit: number;
  percentUsed: number;
};

// ── Parameter Types ────────────────────────────────────────────

/** Parameters for creating a billing customer. */
export type CreateBillingCustomerParams = {
  tenantId: TenantId;
  provider: BillingProviderName;
  externalCustomerId: string;
};

/** Parameters for creating a subscription. */
export type CreateSubscriptionParams = {
  tenantId: TenantId;
  plan: TenantPlan;
  /** Payment method ID or token from the provider. */
  paymentMethodId?: string;
};

/** Parameters for canceling a subscription. */
export type CancelSubscriptionParams = {
  tenantId: TenantId;
  /** If true, cancel at end of current billing period. If false, cancel immediately. */
  atPeriodEnd?: boolean;
};

/** Parameters for recording usage. */
export type RecordUsageParams = {
  tenantId: TenantId;
  agentId?: string;
  date: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedCostUsd: number;
  messageCount: number;
};

/** Parameters for checking or incrementing quota. */
export type QuotaCheckParams = {
  tenantId: TenantId;
  quotaId: QuotaId;
  increment: number;
};

/** Parameters for listing invoices. */
export type ListInvoicesParams = {
  tenantId: TenantId;
  limit?: number;
  startingAfter?: string;
};

/** Parameters for aggregating a usage report. */
export type UsageReportParams = {
  tenantId: TenantId;
  startDate: string;
  endDate: string;
};

/** Aggregated usage summary for a tenant over a date range. */
export type UsageSummary = {
  tenantId: TenantId;
  startDate: string;
  endDate: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalMessages: number;
};

/** Daily usage breakdown for a single date. */
export type DailyUsage = {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalMessages: number;
  byModel: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    messageCount: number;
  }>;
};

/** Combined billing status for tenant dashboard. */
export type BillingStatus = {
  customer: BillingCustomer | null;
  subscription: BillingSubscription | null;
  quotas: QuotaStatus[];
  currentMonthUsage: UsageSummary | null;
};
