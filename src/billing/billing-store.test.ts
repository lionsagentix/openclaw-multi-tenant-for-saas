import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaId } from "./types.js";

// Mock the database module.
const mockQuery = vi.fn();
const _mockConnect = vi.fn();
const mockRelease = vi.fn();

vi.mock("../control-plane/db.js", () => ({
  getDb: () => ({
    query: mockQuery,
    connect: () =>
      Promise.resolve({
        query: mockQuery,
        release: mockRelease,
      }),
  }),
}));

const {
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
} = await import("./billing-store.js");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-03-20T12:00:00Z");

function makeCustomerRow() {
  return {
    tenant_id: TENANT_ID,
    provider: "stripe",
    external_customer_id: "cus_test123",
    created_at: NOW,
  };
}

function makeSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-uuid-1",
    tenant_id: TENANT_ID,
    provider: "stripe",
    external_subscription_id: "sub_test123",
    plan_id: "pro",
    status: "active",
    current_period_start: NOW,
    current_period_end: new Date("2026-04-20T12:00:00Z"),
    cancel_at_period_end: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("billing-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Customer Operations ──────────────────────────────────────

  describe("createBillingCustomer", () => {
    it("inserts a customer and returns mapped object", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCustomerRow()] });

      const customer = await createBillingCustomer({
        tenantId: TENANT_ID,
        provider: "stripe",
        externalCustomerId: "cus_test123",
      });

      expect(customer.tenantId).toBe(TENANT_ID);
      expect(customer.provider).toBe("stripe");
      expect(customer.externalCustomerId).toBe("cus_test123");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO billing_customers"),
        [TENANT_ID, "stripe", "cus_test123"],
      );
    });
  });

  describe("getBillingCustomer", () => {
    it("returns customer when found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCustomerRow()] });
      const customer = await getBillingCustomer(TENANT_ID);
      expect(customer).not.toBeNull();
      expect(customer!.tenantId).toBe(TENANT_ID);
    });

    it("returns null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const customer = await getBillingCustomer("nonexistent");
      expect(customer).toBeNull();
    });
  });

  describe("getBillingCustomerByExternalId", () => {
    it("looks up by provider and external ID", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCustomerRow()] });
      const customer = await getBillingCustomerByExternalId("stripe", "cus_test123");
      expect(customer!.externalCustomerId).toBe("cus_test123");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("provider = $1 AND external_customer_id = $2"),
        ["stripe", "cus_test123"],
      );
    });
  });

  describe("deleteBillingCustomer", () => {
    it("returns true when a row is deleted", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      const result = await deleteBillingCustomer(TENANT_ID);
      expect(result).toBe(true);
    });

    it("returns false when no rows deleted", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      const result = await deleteBillingCustomer("nonexistent");
      expect(result).toBe(false);
    });
  });

  // ── Subscription Operations ──────────────────────────────────

  describe("createBillingSubscription", () => {
    it("inserts subscription and returns mapped object", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSubscriptionRow()] });

      const sub = await createBillingSubscription({
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_test123",
        planId: "pro",
        status: "active",
      });

      expect(sub.tenantId).toBe(TENANT_ID);
      expect(sub.status).toBe("active");
      expect(sub.planId).toBe("pro");
    });
  });

  describe("getBillingSubscription", () => {
    it("returns subscription by ID", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSubscriptionRow()] });
      const sub = await getBillingSubscription("sub-uuid-1");
      expect(sub).not.toBeNull();
      expect(sub!.id).toBe("sub-uuid-1");
    });
  });

  describe("getActiveBillingSubscription", () => {
    it("returns active subscription for tenant", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSubscriptionRow()] });
      const sub = await getActiveBillingSubscription(TENANT_ID);
      expect(sub).not.toBeNull();
      expect(sub!.status).toBe("active");
    });

    it("returns null when no active subscription", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const sub = await getActiveBillingSubscription(TENANT_ID);
      expect(sub).toBeNull();
    });
  });

  describe("updateBillingSubscription", () => {
    it("updates specified fields and returns updated record", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeSubscriptionRow({ status: "past_due" })],
      });

      const sub = await updateBillingSubscription("sub-uuid-1", {
        status: "past_due",
      });

      expect(sub!.status).toBe("past_due");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE billing_subscriptions SET"),
        expect.arrayContaining(["past_due", "sub-uuid-1"]),
      );
    });

    it("returns existing when no updates provided", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSubscriptionRow()] });
      const sub = await updateBillingSubscription("sub-uuid-1", {});
      expect(sub).not.toBeNull();
    });
  });

  describe("listBillingSubscriptions", () => {
    it("returns all subscriptions for tenant", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeSubscriptionRow(), makeSubscriptionRow({ id: "sub-uuid-2" })],
      });
      const subs = await listBillingSubscriptions(TENANT_ID);
      expect(subs).toHaveLength(2);
    });
  });

  // ── Usage Operations ─────────────────────────────────────────

  describe("insertUsageRecord", () => {
    it("inserts a usage record", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            tenant_id: TENANT_ID,
            agent_id: null,
            date: new Date("2026-03-20"),
            provider: "anthropic",
            model: "claude-3-opus",
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 1500,
            estimated_cost_usd: 0.03,
            message_count: 1,
            collected_at: NOW,
          },
        ],
      });

      const record = await insertUsageRecord({
        tenantId: TENANT_ID,
        date: "2026-03-20",
        provider: "anthropic",
        model: "claude-3-opus",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: 0.03,
        messageCount: 1,
      });

      expect(record.totalTokens).toBe(1500);
      expect(record.estimatedCostUsd).toBe(0.03);
    });
  });

  describe("getUsageSummary", () => {
    it("returns aggregated totals", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            total_input_tokens: "5000",
            total_output_tokens: "2500",
            total_cache_read_tokens: "100",
            total_cache_write_tokens: "50",
            total_tokens: "7650",
            total_cost_usd: "0.15",
            total_messages: "10",
          },
        ],
      });

      const summary = await getUsageSummary(TENANT_ID, "2026-03-01", "2026-03-20");
      expect(summary.totalTokens).toBe(7650);
      expect(summary.totalCostUsd).toBe(0.15);
      expect(summary.totalMessages).toBe(10);
    });
  });

  describe("getDailyUsage", () => {
    it("returns daily totals with model breakdown", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              total_input_tokens: "1000",
              total_output_tokens: "500",
              total_tokens: "1500",
              total_cost_usd: "0.03",
              total_messages: "5",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              provider: "anthropic",
              model: "claude-3-opus",
              input_tokens: "1000",
              output_tokens: "500",
              total_tokens: "1500",
              estimated_cost_usd: "0.03",
              message_count: "5",
            },
          ],
        });

      const daily = await getDailyUsage(TENANT_ID, "2026-03-20");
      expect(daily.totalTokens).toBe(1500);
      expect(daily.byModel).toHaveLength(1);
      expect(daily.byModel[0].model).toBe("claude-3-opus");
    });
  });

  // ── Rate Limit Operations ────────────────────────────────────

  describe("incrementQuotaBucket", () => {
    it("returns new value when within limit", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ current_value: 10 }] });

      const result = await incrementQuotaBucket({
        tenantId: TENANT_ID,
        quotaId: "messages_per_day" as QuotaId,
        windowStart: "2026-03-20T00:00:00Z",
        increment: 1,
        limit: 100,
      });

      expect(result).not.toBeNull();
      expect(result!.newValue).toBe(10);
    });

    it("returns null when quota exceeded", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await incrementQuotaBucket({
        tenantId: TENANT_ID,
        quotaId: "messages_per_day" as QuotaId,
        windowStart: "2026-03-20T00:00:00Z",
        increment: 1,
        limit: 100,
      });

      expect(result).toBeNull();
    });
  });

  describe("getQuotaBucketValue", () => {
    it("returns current value when bucket exists", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ current_value: 42 }] });
      const value = await getQuotaBucketValue(
        TENANT_ID,
        "messages_per_day",
        "2026-03-20T00:00:00Z",
      );
      expect(value).toBe(42);
    });

    it("returns 0 when bucket does not exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const value = await getQuotaBucketValue(
        TENANT_ID,
        "messages_per_day",
        "2026-03-20T00:00:00Z",
      );
      expect(value).toBe(0);
    });
  });

  describe("cleanupOldBuckets", () => {
    it("returns count of deleted rows", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });
      const count = await cleanupOldBuckets("2025-12-01T00:00:00Z");
      expect(count).toBe(5);
    });
  });

  // ── Webhook Idempotency ──────────────────────────────────────

  describe("hasProcessedWebhookEvent", () => {
    it("returns true when event already processed", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ "1": 1 }] });
      const result = await hasProcessedWebhookEvent("evt_123", "stripe");
      expect(result).toBe(true);
    });

    it("returns false when event not yet processed", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await hasProcessedWebhookEvent("evt_456", "stripe");
      expect(result).toBe(false);
    });
  });
});
