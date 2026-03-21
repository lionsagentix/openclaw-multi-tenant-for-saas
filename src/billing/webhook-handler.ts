/**
 * Webhook handler for billing provider events.
 *
 * HTTP handler for POST /billing/webhooks/:provider.
 * Verifies signatures, enforces idempotency, routes events to handlers,
 * and writes audit log entries.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { suspendTenant, resumeTenant } from "../tenants/tenant-store.js";
import { writeAuditLog } from "../tenants/tenant-store.js";
import { getBillingProvider } from "./billing-provider.js";
import {
  createBillingSubscription,
  getBillingCustomerByExternalId,
  getActiveBillingSubscription,
  hasProcessedWebhookEvent,
  updateBillingSubscription,
} from "./billing-store.js";
import type { BillingProviderName, BillingWebhookEvent } from "./types.js";
import { WEBHOOK_SIGNATURE_HEADERS } from "./types.js";

const log = createSubsystemLogger("billing/webhook-handler");

// ── Webhook Config ─────────────────────────────────────────────

export type WebhookHandlerConfig = {
  /** Maps provider name -> webhook signing secret. */
  webhookSecrets: Partial<Record<BillingProviderName, string>>;
  /** Maximum payment failures before auto-suspend. */
  maxPaymentFailures?: number;
};

// ── Response Helpers ───────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
}

// ── Raw Body Reader ────────────────────────────────────────────

function readRawBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Event Handlers ─────────────────────────────────────────────

async function handleSubscriptionCreated(event: BillingWebhookEvent): Promise<void> {
  const data = event.data;
  const customerId = (data.customer as string) ?? "";

  const customer = await getBillingCustomerByExternalId(event.provider, customerId);
  if (!customer) {
    log.warn(`No billing customer found for external ID ${customerId}`);
    return;
  }

  await createBillingSubscription({
    tenantId: customer.tenantId,
    provider: event.provider,
    externalSubscriptionId: (data.id as string) ?? "",
    planId:
      (data.plan_id as string) ?? ((data.plan as Record<string, unknown>)?.id as string) ?? "",
    status: ((data.status as string) ?? "active") as "active",
    currentPeriodStart: data.current_period_start
      ? new Date((data.current_period_start as number) * 1000).toISOString()
      : undefined,
    currentPeriodEnd: data.current_period_end
      ? new Date((data.current_period_end as number) * 1000).toISOString()
      : undefined,
  });

  log.info(`Created subscription for tenant ${customer.tenantId}`);
}

async function handleSubscriptionUpdated(event: BillingWebhookEvent): Promise<void> {
  const data = event.data;
  const externalSubId = data.id as string;

  const customer = await getBillingCustomerByExternalId(
    event.provider,
    (data.customer as string) ?? "",
  );
  if (!customer) {
    return;
  }

  const existing = await getActiveBillingSubscription(customer.tenantId);
  if (existing) {
    await updateBillingSubscription(existing.id, {
      status: ((data.status as string) ?? existing.status) as typeof existing.status,
      cancelAtPeriodEnd: (data.cancel_at_period_end as boolean) ?? existing.cancelAtPeriodEnd,
      currentPeriodStart: data.current_period_start
        ? new Date((data.current_period_start as number) * 1000).toISOString()
        : undefined,
      currentPeriodEnd: data.current_period_end
        ? new Date((data.current_period_end as number) * 1000).toISOString()
        : undefined,
    });
  }

  log.info(`Updated subscription ${externalSubId} for tenant ${customer.tenantId}`);
}

async function handleSubscriptionCanceled(event: BillingWebhookEvent): Promise<void> {
  const data = event.data;
  const customer = await getBillingCustomerByExternalId(
    event.provider,
    (data.customer as string) ?? "",
  );
  if (!customer) {
    return;
  }

  const existing = await getActiveBillingSubscription(customer.tenantId);
  if (existing) {
    await updateBillingSubscription(existing.id, { status: "canceled" });
  }

  // Suspend the tenant since their subscription was canceled.
  await suspendTenant(customer.tenantId, "Billing subscription canceled");
  log.info(`Subscription canceled, tenant ${customer.tenantId} suspended.`);
}

async function handleInvoicePaid(event: BillingWebhookEvent): Promise<void> {
  const data = event.data;
  const customerId = (data.customer as string) ?? "";

  const customer = await getBillingCustomerByExternalId(event.provider, customerId);
  if (!customer) {
    return;
  }

  // Resume if tenant was suspended due to billing.
  await resumeTenant(customer.tenantId);
  log.info(`Invoice paid for tenant ${customer.tenantId}, resumed if suspended.`);
}

async function handleInvoicePaymentFailed(
  event: BillingWebhookEvent,
  config: WebhookHandlerConfig,
): Promise<void> {
  const data = event.data;
  const customerId = (data.customer as string) ?? "";

  const customer = await getBillingCustomerByExternalId(event.provider, customerId);
  if (!customer) {
    return;
  }

  // Mark subscription as past_due.
  const subscription = await getActiveBillingSubscription(customer.tenantId);
  if (subscription) {
    await updateBillingSubscription(subscription.id, { status: "past_due" });
  }

  // Check attempt count — suspend after max failures.
  const attemptCount = (data.attempt_count as number) ?? 0;
  const maxFailures = config.maxPaymentFailures ?? 3;

  if (attemptCount >= maxFailures) {
    await suspendTenant(customer.tenantId, "Payment failed after multiple attempts");
    log.warn(`Tenant ${customer.tenantId} suspended after ${attemptCount} payment failures.`);
  } else {
    log.info(
      `Payment failed for tenant ${customer.tenantId} (attempt ${attemptCount}/${maxFailures}).`,
    );
  }
}

async function handleCustomerDeleted(event: BillingWebhookEvent): Promise<void> {
  const data = event.data;
  const customerId = (data.id as string) ?? "";
  log.info(`Customer ${customerId} deleted at provider ${event.provider}.`);
  // Customer cleanup is handled by the billing lifecycle teardown.
}

// ── Main Handler ───────────────────────────────────────────────

/**
 * Create the webhook HTTP handler.
 *
 * Returns a handler function for POST /billing/webhooks/:provider.
 */
export function createWebhookHandler(config: WebhookHandlerConfig) {
  return async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    providerName: BillingProviderName,
  ): Promise<void> {
    // Validate provider.
    const secret = config.webhookSecrets[providerName];
    if (!secret) {
      sendJson(res, 400, { error: { message: `Unknown provider: ${providerName}` } });
      return;
    }

    let provider;
    try {
      provider = getBillingProvider(providerName);
    } catch {
      sendJson(res, 400, { error: { message: `Provider ${providerName} not registered.` } });
      return;
    }

    // Read raw body (needed before JSON parse for signature verification).
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      sendJson(res, 413, {
        error: { message: err instanceof Error ? err.message : "Payload too large" },
      });
      return;
    }

    // Verify signature.
    const signatureHeader = WEBHOOK_SIGNATURE_HEADERS[providerName];
    const signature = req.headers[signatureHeader] as string | undefined;

    if (!signature) {
      sendUnauthorized(res);
      return;
    }

    const valid = await provider.verifyWebhookSignature(rawBody, signature, secret);
    if (!valid) {
      sendUnauthorized(res);
      return;
    }

    // Parse the event.
    let event: BillingWebhookEvent;
    try {
      event = await provider.parseWebhookEvent(rawBody);
    } catch (err) {
      log.error(
        `Failed to parse webhook event: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 400, { error: { message: "Failed to parse webhook event." } });
      return;
    }

    // Idempotency check.
    const alreadyProcessed = await hasProcessedWebhookEvent(event.id, providerName);
    if (alreadyProcessed) {
      log.debug(`Webhook event ${event.id} already processed, skipping.`);
      sendJson(res, 200, { received: true, duplicate: true });
      return;
    }

    // Route to event handler.
    try {
      switch (event.type) {
        case "subscription.created":
          await handleSubscriptionCreated(event);
          break;
        case "subscription.updated":
          await handleSubscriptionUpdated(event);
          break;
        case "subscription.canceled":
          await handleSubscriptionCanceled(event);
          break;
        case "invoice.paid":
          await handleInvoicePaid(event);
          break;
        case "invoice.payment_failed":
          await handleInvoicePaymentFailed(event, config);
          break;
        case "customer.deleted":
          await handleCustomerDeleted(event);
          break;
      }
    } catch (err) {
      log.error(
        `Error handling webhook event ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 500, { error: { message: "Internal server error." } });
      return;
    }

    // Write audit log entry.
    await writeAuditLog({
      actor: `webhook:${providerName}`,
      action: "billing.webhook.processed",
      resourceType: "webhook",
      resourceId: event.id,
      details: { provider: providerName, eventType: event.type },
    });

    sendJson(res, 200, { received: true });
  };
}
