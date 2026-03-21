/**
 * Billing lifecycle coordinator.
 *
 * High-level operations that combine billing store (database), provider
 * (payment service), and tenant management into complete billing workflows.
 *
 * Follows the factory pattern from `src/tenants/tenant-lifecycle.ts`.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getTenant, resumeTenant, suspendTenant, writeAuditLog } from "../tenants/tenant-store.js";
import type { TenantPlan } from "../tenants/types.js";
import { getBillingProvider, getProviderForTenant } from "./billing-provider.js";
import {
  createBillingCustomer,
  createBillingSubscription,
  deleteBillingCustomer,
  getActiveBillingSubscription,
  getBillingCustomer,
  updateBillingSubscription,
} from "./billing-store.js";
import { getQuotaStatus } from "./quota-enforcement.js";
import type { BillingProviderName, BillingStatus } from "./types.js";
import { DEFAULT_BILLING_PROVIDER } from "./types.js";
import { getUsageSummaryForTenant } from "./usage-metering.js";

const log = createSubsystemLogger("billing/lifecycle");

// ── Configuration ──────────────────────────────────────────────

export type BillingLifecycleConfig = {
  /** Default billing provider for new tenants. */
  defaultProvider?: BillingProviderName;
};

// ── Factory ────────────────────────────────────────────────────

/**
 * Create a billing lifecycle coordinator.
 *
 * Provides high-level billing operations used by the control plane.
 */
export function createBillingLifecycle(config: BillingLifecycleConfig = {}) {
  const defaultProvider = config.defaultProvider ?? DEFAULT_BILLING_PROVIDER;

  /**
   * Set up billing for a newly provisioned tenant.
   *
   * Creates a customer at the billing provider, starts a subscription,
   * and stores the records in the database.
   */
  async function setupBillingForTenant(
    tenantId: string,
    providerName?: BillingProviderName,
  ): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found.`);
    }

    const provider = getBillingProvider(providerName ?? defaultProvider);

    // Create customer at provider.
    const { externalCustomerId } = await provider.createCustomer({
      tenantId,
      email: tenant.contactEmail,
      name: tenant.displayName,
      metadata: { slug: tenant.slug, plan: tenant.plan },
    });

    // Store customer record.
    await createBillingCustomer({
      tenantId,
      provider: provider.name,
      externalCustomerId,
    });

    // Create subscription.
    const subResult = await provider.createSubscription(externalCustomerId, {
      tenantId,
      plan: tenant.plan,
    });

    // Store subscription record.
    await createBillingSubscription({
      tenantId,
      provider: provider.name,
      externalSubscriptionId: subResult.externalSubscriptionId,
      planId: tenant.plan,
      status: subResult.status,
      currentPeriodStart: subResult.currentPeriodStart,
      currentPeriodEnd: subResult.currentPeriodEnd,
    });

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.setup",
      resourceType: "billing_customer",
      resourceId: externalCustomerId,
      details: { provider: provider.name, plan: tenant.plan },
    });

    log.info(`Billing setup complete for tenant ${tenant.slug} (${provider.name}).`);
  }

  /**
   * Change a tenant's billing plan.
   *
   * Updates the subscription at the provider and in the database.
   */
  async function changePlan(tenantId: string, newPlan: TenantPlan): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found.`);
    }

    const subscription = await getActiveBillingSubscription(tenantId);
    if (!subscription) {
      throw new Error(`No active subscription for tenant ${tenantId}.`);
    }

    const provider = await getProviderForTenant(tenantId);

    // Change plan at provider.
    const result = await provider.changeSubscriptionPlan(
      subscription.externalSubscriptionId,
      newPlan,
    );

    // Update subscription record.
    await updateBillingSubscription(subscription.id, {
      planId: result.planId,
      status: result.status,
    });

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.plan_changed",
      resourceType: "billing_subscription",
      resourceId: subscription.id,
      details: { oldPlan: tenant.plan, newPlan },
    });

    log.info(`Plan changed for tenant ${tenant.slug}: ${tenant.plan} -> ${newPlan}.`);
  }

  /**
   * Cancel billing for a tenant.
   *
   * Cancels the subscription at the provider and optionally suspends the tenant.
   */
  async function cancelBilling(tenantId: string, atPeriodEnd = true): Promise<void> {
    const subscription = await getActiveBillingSubscription(tenantId);
    if (!subscription) {
      log.warn(`No active subscription to cancel for tenant ${tenantId}.`);
      return;
    }

    const provider = await getProviderForTenant(tenantId);

    await provider.cancelSubscription(subscription.externalSubscriptionId, {
      tenantId,
      atPeriodEnd,
    });

    if (atPeriodEnd) {
      await updateBillingSubscription(subscription.id, { cancelAtPeriodEnd: true });
    } else {
      await updateBillingSubscription(subscription.id, { status: "canceled" });
      await suspendTenant(tenantId, "Billing canceled");
    }

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.canceled",
      resourceType: "billing_subscription",
      resourceId: subscription.id,
      details: { atPeriodEnd },
    });

    log.info(`Billing canceled for tenant ${tenantId} (atPeriodEnd: ${atPeriodEnd}).`);
  }

  /**
   * Handle a payment failure for a tenant.
   *
   * Marks the subscription as past_due and suspends after max failures.
   */
  async function handlePaymentFailure(tenantId: string, _maxFailures = 3): Promise<void> {
    const subscription = await getActiveBillingSubscription(tenantId);
    if (subscription) {
      await updateBillingSubscription(subscription.id, { status: "past_due" });
    }

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.payment_failed",
      resourceType: "tenant",
      resourceId: tenantId,
    });

    log.warn(`Payment failure for tenant ${tenantId}.`);
  }

  /**
   * Handle a successful payment for a tenant.
   *
   * Resumes the tenant if they were suspended for billing reasons.
   */
  async function handlePaymentSuccess(tenantId: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return;
    }

    if (tenant.status === "suspended") {
      await resumeTenant(tenantId);
      log.info(`Tenant ${tenant.slug} resumed after successful payment.`);
    }

    // Restore subscription to active.
    const subscription = await getActiveBillingSubscription(tenantId);
    if (subscription && subscription.status === "past_due") {
      await updateBillingSubscription(subscription.id, { status: "active" });
    }

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.payment_success",
      resourceType: "tenant",
      resourceId: tenantId,
    });
  }

  /**
   * Tear down all billing for a tenant.
   *
   * Cancels the subscription, deletes the customer at the provider,
   * and removes billing records.
   */
  async function teardownBilling(tenantId: string): Promise<void> {
    const subscription = await getActiveBillingSubscription(tenantId);
    const customer = await getBillingCustomer(tenantId);

    if (subscription) {
      try {
        const provider = await getProviderForTenant(tenantId);
        await provider.cancelSubscription(subscription.externalSubscriptionId, {
          tenantId,
          atPeriodEnd: false,
        });
      } catch (err) {
        log.error(
          `Failed to cancel subscription at provider: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await updateBillingSubscription(subscription.id, { status: "canceled" });
    }

    if (customer) {
      try {
        const provider = getBillingProvider(customer.provider);
        await provider.deleteCustomer(customer.externalCustomerId);
      } catch (err) {
        log.error(
          `Failed to delete customer at provider: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await deleteBillingCustomer(tenantId);
    }

    await writeAuditLog({
      tenantId,
      actor: "billing-lifecycle",
      action: "billing.teardown",
      resourceType: "tenant",
      resourceId: tenantId,
    });

    log.info(`Billing teardown complete for tenant ${tenantId}.`);
  }

  /**
   * Get the full billing status for a tenant (for dashboard).
   */
  async function getBillingStatus(tenantId: string): Promise<BillingStatus> {
    const customer = await getBillingCustomer(tenantId);
    const subscription = await getActiveBillingSubscription(tenantId);
    const quotas = await getQuotaStatus(tenantId);

    // Current month usage.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .split("T")[0];
    const today = now.toISOString().split("T")[0];

    let currentMonthUsage = null;
    try {
      currentMonthUsage = await getUsageSummaryForTenant(tenantId, monthStart, today);
    } catch (err) {
      log.error(`Failed to get usage summary: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      customer,
      subscription,
      quotas,
      currentMonthUsage,
    };
  }

  return {
    setupBillingForTenant,
    changePlan,
    cancelBilling,
    handlePaymentFailure,
    handlePaymentSuccess,
    teardownBilling,
    getBillingStatus,
  };
}

export type BillingLifecycle = ReturnType<typeof createBillingLifecycle>;
