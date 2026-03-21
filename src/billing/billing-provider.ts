/**
 * Payment-provider-agnostic billing interface and provider registry.
 *
 * Each tenant can use a different billing provider. The registry maps provider
 * names to implementations and resolves the correct provider for each tenant.
 */

import { getBillingCustomer } from "./billing-store.js";
import type {
  BillingCustomer,
  BillingInvoice,
  BillingProviderName,
  BillingSubscription,
  BillingWebhookEvent,
  CancelSubscriptionParams,
  CreateSubscriptionParams,
  ListInvoicesParams,
} from "./types.js";
import { DEFAULT_BILLING_PROVIDER } from "./types.js";

// ── Provider Interface ─────────────────────────────────────────

/** Abstract billing provider that each payment service must implement. */
export type BillingProvider = {
  readonly name: BillingProviderName;

  // Customer management.
  createCustomer(params: {
    tenantId: string;
    email: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<{ externalCustomerId: string }>;

  getCustomer(externalCustomerId: string): Promise<BillingCustomer | null>;

  deleteCustomer(externalCustomerId: string): Promise<void>;

  // Subscription management.
  createSubscription(
    externalCustomerId: string,
    params: CreateSubscriptionParams,
  ): Promise<{
    externalSubscriptionId: string;
    status: BillingSubscription["status"];
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  }>;

  cancelSubscription(
    externalSubscriptionId: string,
    params: CancelSubscriptionParams,
  ): Promise<void>;

  changeSubscriptionPlan(
    externalSubscriptionId: string,
    newPlanId: string,
  ): Promise<{
    status: BillingSubscription["status"];
    planId: string;
  }>;

  // Usage reporting.
  reportUsage(
    externalSubscriptionId: string,
    params: { quantity: number; timestamp?: string; action?: string },
  ): Promise<void>;

  // Invoicing.
  getUpcomingInvoice(externalCustomerId: string): Promise<BillingInvoice | null>;

  listInvoices(params: ListInvoicesParams & { externalCustomerId: string }): Promise<{
    invoices: BillingInvoice[];
    hasMore: boolean;
  }>;

  // Webhook verification and parsing.
  verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): Promise<boolean>;

  parseWebhookEvent(rawBody: Buffer): Promise<BillingWebhookEvent>;
};

// ── Provider Registry ──────────────────────────────────────────

const providers = new Map<BillingProviderName, BillingProvider>();

/** Register a billing provider implementation. */
export function registerBillingProvider(provider: BillingProvider): void {
  providers.set(provider.name, provider);
}

/** Get a billing provider by name. Throws if not registered. */
export function getBillingProvider(name: BillingProviderName): BillingProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`Billing provider "${name}" is not registered.`);
  }
  return provider;
}

/**
 * Get the billing provider for a specific tenant.
 * Looks up the tenant's billing customer record to determine which provider to use.
 * Falls back to the default provider if no customer record exists.
 */
export async function getProviderForTenant(tenantId: string): Promise<BillingProvider> {
  const customer = await getBillingCustomer(tenantId);
  const providerName = customer?.provider ?? DEFAULT_BILLING_PROVIDER;
  return getBillingProvider(providerName);
}

/** Get all registered provider names. */
export function getRegisteredProviders(): BillingProviderName[] {
  return [...providers.keys()];
}

/** Clear all registered providers (for testing). */
export function clearProviderRegistry(): void {
  providers.clear();
}
