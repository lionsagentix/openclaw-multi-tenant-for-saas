/**
 * Stripe billing provider implementation.
 *
 * Full implementation using the Stripe SDK. Maps Stripe-specific concepts
 * (prices, subscription items, webhook events) to the provider-agnostic
 * billing interface.
 */

import Stripe from "stripe";
import type { TenantPlan } from "../../tenants/types.js";
import type { BillingProvider } from "../billing-provider.js";
import type {
  BillingInvoice,
  BillingInvoiceLineItem,
  BillingSubscriptionStatus,
  BillingWebhookEvent,
  WebhookEventType,
} from "../types.js";

// ── Configuration ──────────────────────────────────────────────

export type StripeProviderConfig = {
  /** Stripe secret API key. */
  secretKey: string;
  /** Stripe webhook signing secret. */
  webhookSecret: string;
  /** Maps tenant plan tiers to Stripe Price IDs. */
  planPriceMap: Record<TenantPlan, string>;
};

// ── Event Type Mapping ─────────────────────────────────────────

/** Map Stripe event types to normalized billing event types. */
const STRIPE_EVENT_MAP: Record<string, WebhookEventType> = {
  "customer.subscription.created": "subscription.created",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.canceled",
  "invoice.paid": "invoice.paid",
  "invoice.payment_failed": "invoice.payment_failed",
  "customer.deleted": "customer.deleted",
};

// ── Status Mapping ─────────────────────────────────────────────

function mapStripeSubscriptionStatus(status: string): BillingSubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "unpaid":
    case "incomplete":
      return "unpaid";
    default:
      return "active";
  }
}

// ── Invoice Mapping ────────────────────────────────────────────

function mapStripeInvoice(invoice: Stripe.Invoice): BillingInvoice {
  const lineItems: BillingInvoiceLineItem[] = (invoice.lines?.data ?? []).map((line) => ({
    description: line.description ?? "",
    quantity: line.quantity ?? 1,
    unitAmount: line.pricing?.unit_amount_decimal
      ? Number(line.pricing.unit_amount_decimal)
      : (line.amount ?? 0),
    amount: line.amount ?? 0,
  }));

  // In Stripe v20, subscription is under parent.subscription_details.
  const subscriptionRef = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = subscriptionRef
    ? typeof subscriptionRef === "string"
      ? subscriptionRef
      : subscriptionRef.id
    : undefined;

  return {
    id: invoice.id ?? "",
    customerId:
      typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? ""),
    subscriptionId,
    status: invoice.status ?? "draft",
    currency: invoice.currency ?? "usd",
    amountDue: invoice.amount_due ?? 0,
    amountPaid: invoice.amount_paid ?? 0,
    lineItems,
    periodStart: invoice.period_start
      ? new Date(invoice.period_start * 1000).toISOString()
      : undefined,
    periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : undefined,
    createdAt: invoice.created
      ? new Date(invoice.created * 1000).toISOString()
      : new Date().toISOString(),
    paidAt: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : undefined,
    hostedUrl: invoice.hosted_invoice_url ?? undefined,
  };
}

// ── Provider Factory ───────────────────────────────────────────

export function createStripeProvider(config: StripeProviderConfig): BillingProvider {
  const stripe = new Stripe(config.secretKey);

  return {
    name: "stripe",

    // ── Customer ──────────────────────────────────────────────

    async createCustomer(params) {
      const customer = await stripe.customers.create({
        email: params.email,
        name: params.name,
        metadata: {
          tenantId: params.tenantId,
          ...params.metadata,
        },
      });

      return { externalCustomerId: customer.id };
    },

    async getCustomer(externalCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(externalCustomerId);
        if (customer.deleted) {
          return null;
        }
        return {
          tenantId: customer.metadata?.tenantId ?? "",
          provider: "stripe" as const,
          externalCustomerId: customer.id,
          createdAt: new Date(customer.created * 1000).toISOString(),
        };
      } catch {
        return null;
      }
    },

    async deleteCustomer(externalCustomerId) {
      await stripe.customers.del(externalCustomerId);
    },

    // ── Subscriptions ─────────────────────────────────────────

    async createSubscription(externalCustomerId, params) {
      const priceId = config.planPriceMap[params.plan];
      if (!priceId) {
        throw new Error(`No Stripe price configured for plan "${params.plan}".`);
      }

      const subParams: Stripe.SubscriptionCreateParams = {
        customer: externalCustomerId,
        items: [{ price: priceId }],
        metadata: { tenantId: params.tenantId },
      };

      if (params.paymentMethodId) {
        subParams.default_payment_method = params.paymentMethodId;
      }

      const subscription = await stripe.subscriptions.create(subParams);

      // In Stripe v20, period info is on the first line item, not the subscription.
      const firstItem = subscription.items.data[0];
      const periodStart = firstItem?.current_period_start;
      const periodEnd = firstItem?.current_period_end;

      return {
        externalSubscriptionId: subscription.id,
        status: mapStripeSubscriptionStatus(subscription.status),
        currentPeriodStart: periodStart ? new Date(periodStart * 1000).toISOString() : undefined,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
      };
    },

    async cancelSubscription(externalSubscriptionId, params) {
      if (params.atPeriodEnd) {
        await stripe.subscriptions.update(externalSubscriptionId, {
          cancel_at_period_end: true,
        });
      } else {
        await stripe.subscriptions.cancel(externalSubscriptionId);
      }
    },

    async changeSubscriptionPlan(externalSubscriptionId, newPlanId) {
      const subscription = await stripe.subscriptions.retrieve(externalSubscriptionId);
      const itemId = subscription.items.data[0]?.id;

      if (!itemId) {
        throw new Error("Subscription has no items to update.");
      }

      const updated = await stripe.subscriptions.update(externalSubscriptionId, {
        items: [{ id: itemId, price: newPlanId }],
        proration_behavior: "create_prorations",
      });

      return {
        status: mapStripeSubscriptionStatus(updated.status),
        planId: newPlanId,
      };
    },

    // ── Usage Reporting ───────────────────────────────────────

    async reportUsage(externalSubscriptionId, params) {
      const subscription = await stripe.subscriptions.retrieve(externalSubscriptionId);

      // Stripe v20 uses meter events for usage-based billing.
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;

      await stripe.billing.meterEvents.create({
        event_name: params.action ?? "ai_token_usage",
        payload: {
          stripe_customer_id: customerId,
          value: String(params.quantity),
        },
        timestamp: params.timestamp
          ? Math.floor(new Date(params.timestamp).getTime() / 1000)
          : undefined,
      });
    },

    // ── Invoicing ─────────────────────────────────────────────

    async getUpcomingInvoice(externalCustomerId) {
      try {
        // Stripe v20 uses createPreview instead of retrieveUpcoming.
        const invoice = await stripe.invoices.createPreview({
          customer: externalCustomerId,
        });
        return mapStripeInvoice(invoice);
      } catch {
        return null;
      }
    },

    async listInvoices(params) {
      const response = await stripe.invoices.list({
        customer: params.externalCustomerId,
        limit: params.limit ?? 10,
        starting_after: params.startingAfter || undefined,
      });

      return {
        invoices: response.data.map(mapStripeInvoice),
        hasMore: response.has_more,
      };
    },

    // ── Webhooks ──────────────────────────────────────────────

    async verifyWebhookSignature(rawBody, signature, secret) {
      try {
        stripe.webhooks.constructEvent(rawBody.toString(), signature, secret);
        return true;
      } catch {
        return false;
      }
    },

    async parseWebhookEvent(rawBody) {
      const event = JSON.parse(rawBody.toString()) as Stripe.Event;

      const normalizedType = STRIPE_EVENT_MAP[event.type];
      if (!normalizedType) {
        throw new Error(`Unhandled Stripe event type: ${event.type}`);
      }

      return {
        id: event.id,
        type: normalizedType,
        provider: "stripe" as const,
        data: event.data.object as unknown as Record<string, unknown>,
        occurredAt: new Date(event.created * 1000).toISOString(),
      } satisfies BillingWebhookEvent;
    },
  };
}
