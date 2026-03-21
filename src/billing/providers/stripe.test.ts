import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the stripe module.
const mockCustomersCreate = vi.fn();
const mockCustomersRetrieve = vi.fn();
const mockCustomersDel = vi.fn();
const mockSubscriptionsCreate = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockSubscriptionsCancel = vi.fn();
const mockMeterEventsCreate = vi.fn();
const mockUsageRecordCreate = vi.fn();
const mockInvoicesRetrieveUpcoming = vi.fn();
const mockInvoicesCreatePreview = vi.fn();
const mockInvoicesList = vi.fn();
const mockWebhooksConstructEvent = vi.fn();

vi.mock("stripe", () => {
  return {
    default: class MockStripe {
      customers = {
        create: mockCustomersCreate,
        retrieve: mockCustomersRetrieve,
        del: mockCustomersDel,
      };
      subscriptions = {
        create: mockSubscriptionsCreate,
        retrieve: mockSubscriptionsRetrieve,
        update: mockSubscriptionsUpdate,
        cancel: mockSubscriptionsCancel,
      };
      billing = {
        meterEvents: { create: mockMeterEventsCreate },
      };
      subscriptionItems = {
        createUsageRecord: mockUsageRecordCreate,
      };
      invoices = {
        retrieveUpcoming: mockInvoicesRetrieveUpcoming,
        createPreview: mockInvoicesCreatePreview,
        list: mockInvoicesList,
      };
      webhooks = {
        constructEvent: mockWebhooksConstructEvent,
      };
    },
  };
});

const { createStripeProvider } = await import("./stripe.js");

const config = {
  secretKey: "sk_test_123",
  webhookSecret: "whsec_test_123",
  planPriceMap: {
    free: "price_free",
    starter: "price_starter",
    pro: "price_pro",
    enterprise: "price_enterprise",
  } as Record<string, string>,
};

describe("stripe provider", () => {
  let provider: ReturnType<typeof createStripeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createStripeProvider(config);
  });

  it("has name 'stripe'", () => {
    expect(provider.name).toBe("stripe");
  });

  describe("createCustomer", () => {
    it("creates a Stripe customer with metadata", async () => {
      mockCustomersCreate.mockResolvedValueOnce({ id: "cus_new_123" });

      const result = await provider.createCustomer({
        tenantId: "tenant-1",
        email: "test@example.com",
        name: "Test Tenant",
      });

      expect(result.externalCustomerId).toBe("cus_new_123");
      expect(mockCustomersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "test@example.com",
          name: "Test Tenant",
          metadata: expect.objectContaining({ tenantId: "tenant-1" }),
        }),
      );
    });
  });

  describe("getCustomer", () => {
    it("returns mapped customer", async () => {
      mockCustomersRetrieve.mockResolvedValueOnce({
        id: "cus_123",
        deleted: false,
        metadata: { tenantId: "tenant-1" },
        created: 1710936000,
      });

      const customer = await provider.getCustomer("cus_123");
      expect(customer).not.toBeNull();
      expect(customer!.provider).toBe("stripe");
    });

    it("returns null for deleted customer", async () => {
      mockCustomersRetrieve.mockResolvedValueOnce({ id: "cus_123", deleted: true });
      const customer = await provider.getCustomer("cus_123");
      expect(customer).toBeNull();
    });

    it("returns null on error", async () => {
      mockCustomersRetrieve.mockRejectedValueOnce(new Error("Not found"));
      const customer = await provider.getCustomer("cus_invalid");
      expect(customer).toBeNull();
    });
  });

  describe("deleteCustomer", () => {
    it("calls stripe.customers.del", async () => {
      mockCustomersDel.mockResolvedValueOnce({});
      await provider.deleteCustomer("cus_123");
      expect(mockCustomersDel).toHaveBeenCalledWith("cus_123");
    });
  });

  describe("createSubscription", () => {
    it("creates subscription with plan price", async () => {
      mockSubscriptionsCreate.mockResolvedValueOnce({
        id: "sub_new_123",
        status: "active",
        items: {
          data: [{ current_period_start: 1710936000, current_period_end: 1713528000 }],
        },
      });

      const result = await provider.createSubscription("cus_123", {
        tenantId: "tenant-1",
        plan: "pro",
      });

      expect(result.externalSubscriptionId).toBe("sub_new_123");
      expect(result.status).toBe("active");
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          items: [{ price: "price_pro" }],
        }),
      );
    });

    it("throws for unknown plan", async () => {
      await expect(
        provider.createSubscription("cus_123", {
          tenantId: "tenant-1",
          plan: "ultra" as "free",
        }),
      ).rejects.toThrow("No Stripe price configured");
    });
  });

  describe("cancelSubscription", () => {
    it("cancels at period end when atPeriodEnd=true", async () => {
      mockSubscriptionsUpdate.mockResolvedValueOnce({});
      await provider.cancelSubscription("sub_123", {
        tenantId: "t1",
        atPeriodEnd: true,
      });
      expect(mockSubscriptionsUpdate).toHaveBeenCalledWith("sub_123", {
        cancel_at_period_end: true,
      });
    });

    it("cancels immediately when atPeriodEnd=false", async () => {
      mockSubscriptionsCancel.mockResolvedValueOnce({});
      await provider.cancelSubscription("sub_123", {
        tenantId: "t1",
        atPeriodEnd: false,
      });
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith("sub_123");
    });
  });

  describe("changeSubscriptionPlan", () => {
    it("updates subscription items with new price", async () => {
      mockSubscriptionsRetrieve.mockResolvedValueOnce({
        items: { data: [{ id: "si_123" }] },
      });
      mockSubscriptionsUpdate.mockResolvedValueOnce({ status: "active" });

      const result = await provider.changeSubscriptionPlan("sub_123", "price_enterprise");
      expect(result.planId).toBe("price_enterprise");
      expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
        "sub_123",
        expect.objectContaining({
          items: [{ id: "si_123", price: "price_enterprise" }],
        }),
      );
    });
  });

  describe("reportUsage", () => {
    it("creates a meter event via Stripe billing API", async () => {
      mockSubscriptionsRetrieve.mockResolvedValueOnce({
        customer: "cus_123",
      });
      mockMeterEventsCreate.mockResolvedValueOnce({});

      await provider.reportUsage("sub_123", {
        quantity: 5000,
        timestamp: "2026-03-20T12:00:00Z",
        action: "ai_token_usage",
      });

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: "ai_token_usage",
          payload: expect.objectContaining({
            stripe_customer_id: "cus_123",
            value: "5000",
          }),
        }),
      );
    });
  });

  describe("getUpcomingInvoice", () => {
    it("returns mapped invoice from createPreview", async () => {
      mockInvoicesCreatePreview.mockResolvedValueOnce({
        id: "inv_preview",
        customer: "cus_123",
        status: "draft",
        currency: "usd",
        amount_due: 2000,
        amount_paid: 0,
        lines: { data: [] },
        period_start: 1710936000,
        period_end: 1713528000,
        created: 1710936000,
        status_transitions: {},
      });

      const invoice = await provider.getUpcomingInvoice("cus_123");

      expect(invoice).not.toBeNull();
      expect(invoice!.id).toBe("inv_preview");
      expect(invoice!.amountDue).toBe(2000);
      expect(mockInvoicesCreatePreview).toHaveBeenCalledWith({ customer: "cus_123" });
    });

    it("returns null on error", async () => {
      mockInvoicesCreatePreview.mockRejectedValueOnce(new Error("No upcoming invoice"));
      const invoice = await provider.getUpcomingInvoice("cus_no_sub");
      expect(invoice).toBeNull();
    });
  });

  describe("listInvoices", () => {
    it("returns mapped invoices with pagination", async () => {
      mockInvoicesList.mockResolvedValueOnce({
        data: [
          {
            id: "inv_1",
            customer: "cus_123",
            status: "paid",
            currency: "usd",
            amount_due: 2000,
            amount_paid: 2000,
            lines: { data: [] },
            created: 1710936000,
            status_transitions: { paid_at: 1710950000 },
          },
        ],
        has_more: false,
      });

      const result = await provider.listInvoices({
        tenantId: "t1",
        externalCustomerId: "cus_123",
        limit: 5,
      });

      expect(result.invoices).toHaveLength(1);
      expect(result.invoices[0].id).toBe("inv_1");
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesList).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_123", limit: 5 }),
      );
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns true when signature is valid", async () => {
      mockWebhooksConstructEvent.mockReturnValueOnce({});
      const result = await provider.verifyWebhookSignature(
        Buffer.from("body"),
        "sig_123",
        "whsec_123",
      );
      expect(result).toBe(true);
    });

    it("returns false when signature is invalid", async () => {
      mockWebhooksConstructEvent.mockImplementationOnce(() => {
        throw new Error("Invalid signature");
      });
      const result = await provider.verifyWebhookSignature(
        Buffer.from("body"),
        "bad_sig",
        "whsec_123",
      );
      expect(result).toBe(false);
    });
  });

  describe("parseWebhookEvent", () => {
    it("maps Stripe event to normalized event", async () => {
      const stripeEvent = {
        id: "evt_123",
        type: "customer.subscription.created",
        created: 1710936000,
        data: { object: { id: "sub_123", customer: "cus_123" } },
      };

      const event = await provider.parseWebhookEvent(Buffer.from(JSON.stringify(stripeEvent)));

      expect(event.id).toBe("evt_123");
      expect(event.type).toBe("subscription.created");
      expect(event.provider).toBe("stripe");
    });

    it("throws for unhandled event types", async () => {
      const stripeEvent = {
        id: "evt_999",
        type: "some.unknown.event",
        created: 1710936000,
        data: { object: {} },
      };

      await expect(
        provider.parseWebhookEvent(Buffer.from(JSON.stringify(stripeEvent))),
      ).rejects.toThrow("Unhandled Stripe event type");
    });
  });
});
