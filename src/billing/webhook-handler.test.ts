import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../tenants/tenant-store.js", () => ({
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("./billing-provider.js", () => ({
  getBillingProvider: vi.fn(),
}));

vi.mock("./billing-store.js", () => ({
  createBillingSubscription: vi.fn(),
  getBillingCustomerByExternalId: vi.fn(),
  getActiveBillingSubscription: vi.fn(),
  hasProcessedWebhookEvent: vi.fn(),
  updateBillingSubscription: vi.fn(),
}));

const { getBillingProvider } = await import("./billing-provider.js");
const {
  getBillingCustomerByExternalId,
  hasProcessedWebhookEvent,
  createBillingSubscription,
  updateBillingSubscription,
  getActiveBillingSubscription,
} = await import("./billing-store.js");
const { suspendTenant, resumeTenant, writeAuditLog } = await import("../tenants/tenant-store.js");
const { createWebhookHandler } = await import("./webhook-handler.js");

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = headers;

  // Simulate data/end events.
  setTimeout(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  }, 0);

  return req;
}

function createMockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? "";
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

const mockProvider = {
  name: "stripe" as const,
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvent: vi.fn(),
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  changeSubscriptionPlan: vi.fn(),
  reportUsage: vi.fn(),
  getUpcomingInvoice: vi.fn(),
  listInvoices: vi.fn(),
};

const config = {
  webhookSecrets: { stripe: "whsec_test" },
  maxPaymentFailures: 3,
};

describe("webhook-handler", () => {
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBillingProvider).mockReturnValue(mockProvider);
    handler = createWebhookHandler(config);
  });

  it("returns 400 for unknown provider", async () => {
    const req = createMockReq("{}");
    const res = createMockRes();

    await handler(req, res, "paddle" as "stripe");

    expect(res._status).toBe(400);
  });

  it("returns 401 when signature header is missing", async () => {
    const req = createMockReq("{}", {});
    const res = createMockRes();

    await handler(req, res, "stripe");

    expect(res._status).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    const req = createMockReq("{}", { "stripe-signature": "bad_sig" });
    const res = createMockRes();

    mockProvider.verifyWebhookSignature.mockResolvedValueOnce(false);

    await handler(req, res, "stripe");

    expect(res._status).toBe(401);
  });

  it("returns 200 with duplicate:true for already processed events", async () => {
    const req = createMockReq("{}", { "stripe-signature": "valid_sig" });
    const res = createMockRes();

    mockProvider.verifyWebhookSignature.mockResolvedValueOnce(true);
    mockProvider.parseWebhookEvent.mockResolvedValueOnce({
      id: "evt_123",
      type: "subscription.created",
      provider: "stripe",
      data: {},
      occurredAt: new Date().toISOString(),
    });
    vi.mocked(hasProcessedWebhookEvent).mockResolvedValueOnce(true);

    await handler(req, res, "stripe");

    expect(res._status).toBe(200);
    expect(res._body).toContain("duplicate");
  });

  it("processes subscription.created event", async () => {
    const req = createMockReq("{}", { "stripe-signature": "valid_sig" });
    const res = createMockRes();

    mockProvider.verifyWebhookSignature.mockResolvedValueOnce(true);
    mockProvider.parseWebhookEvent.mockResolvedValueOnce({
      id: "evt_sub_created",
      type: "subscription.created",
      provider: "stripe",
      data: {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        current_period_start: 1710936000,
        current_period_end: 1713528000,
      },
      occurredAt: new Date().toISOString(),
    });
    vi.mocked(hasProcessedWebhookEvent).mockResolvedValueOnce(false);
    vi.mocked(getBillingCustomerByExternalId).mockResolvedValueOnce({
      tenantId: "tenant-1",
      provider: "stripe",
      externalCustomerId: "cus_123",
      createdAt: "",
    });
    vi.mocked(createBillingSubscription).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof createBillingSubscription>>,
    );

    await handler(req, res, "stripe");

    expect(res._status).toBe(200);
    expect(createBillingSubscription).toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing.webhook.processed" }),
    );
  });

  it("processes invoice.paid event and resumes tenant", async () => {
    const req = createMockReq("{}", { "stripe-signature": "valid_sig" });
    const res = createMockRes();

    mockProvider.verifyWebhookSignature.mockResolvedValueOnce(true);
    mockProvider.parseWebhookEvent.mockResolvedValueOnce({
      id: "evt_inv_paid",
      type: "invoice.paid",
      provider: "stripe",
      data: { customer: "cus_123" },
      occurredAt: new Date().toISOString(),
    });
    vi.mocked(hasProcessedWebhookEvent).mockResolvedValueOnce(false);
    vi.mocked(getBillingCustomerByExternalId).mockResolvedValueOnce({
      tenantId: "tenant-1",
      provider: "stripe",
      externalCustomerId: "cus_123",
      createdAt: "",
    });

    await handler(req, res, "stripe");

    expect(res._status).toBe(200);
    expect(resumeTenant).toHaveBeenCalledWith("tenant-1");
  });

  it("suspends tenant after max payment failures", async () => {
    const req = createMockReq("{}", { "stripe-signature": "valid_sig" });
    const res = createMockRes();

    mockProvider.verifyWebhookSignature.mockResolvedValueOnce(true);
    mockProvider.parseWebhookEvent.mockResolvedValueOnce({
      id: "evt_pay_fail",
      type: "invoice.payment_failed",
      provider: "stripe",
      data: { customer: "cus_123", attempt_count: 3 },
      occurredAt: new Date().toISOString(),
    });
    vi.mocked(hasProcessedWebhookEvent).mockResolvedValueOnce(false);
    vi.mocked(getBillingCustomerByExternalId).mockResolvedValueOnce({
      tenantId: "tenant-1",
      provider: "stripe",
      externalCustomerId: "cus_123",
      createdAt: "",
    });
    vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
      id: "sub-1",
      tenantId: "tenant-1",
      provider: "stripe",
      externalSubscriptionId: "sub_123",
      planId: "pro",
      status: "active",
      cancelAtPeriodEnd: false,
      createdAt: "",
      updatedAt: "",
    });

    await handler(req, res, "stripe");

    expect(res._status).toBe(200);
    expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", { status: "past_due" });
    expect(suspendTenant).toHaveBeenCalledWith(
      "tenant-1",
      "Payment failed after multiple attempts",
    );
  });
});
