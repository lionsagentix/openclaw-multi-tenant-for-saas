import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies.
vi.mock("../tenants/tenant-store.js", () => ({
  getTenantQuotas: vi.fn(),
}));

vi.mock("./billing-store.js", () => ({
  incrementQuotaBucket: vi.fn(),
  getQuotaBucketValue: vi.fn(),
}));

const { getTenantQuotas } = await import("../tenants/tenant-store.js");
const { incrementQuotaBucket, getQuotaBucketValue } = await import("./billing-store.js");
const { checkAndIncrementQuota, checkQuota, getQuotaStatus } =
  await import("./quota-enforcement.js");

const TENANT_ID = "tenant-quota-test";

const mockQuotas = {
  tenantId: TENANT_ID,
  maxAgents: 10,
  maxSessionsPerAgent: 500,
  maxMessagesPerDay: 1000,
  maxTokensPerDay: 1_000_000,
  maxCostPerDayCents: 5000,
  maxCostPerMonthCents: 50_000,
  maxChannels: 10,
  maxStorageBytes: 10 * 1024 * 1024 * 1024,
};

describe("quota-enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkAndIncrementQuota", () => {
    it("allows increment when within limit", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(incrementQuotaBucket).mockResolvedValueOnce({ newValue: 10 });

      const result = await checkAndIncrementQuota({
        tenantId: TENANT_ID,
        quotaId: "messages_per_day",
        increment: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.currentValue).toBe(10);
      expect(result.limit).toBe(1000);
    });

    it("denies when quota exceeded", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(incrementQuotaBucket).mockResolvedValueOnce(null);
      vi.mocked(getQuotaBucketValue).mockResolvedValueOnce(1000);

      const result = await checkAndIncrementQuota({
        tenantId: TENANT_ID,
        quotaId: "messages_per_day",
        increment: 1,
      });

      expect(result.allowed).toBe(false);
      expect(result.currentValue).toBe(1000);
      expect(result.limit).toBe(1000);
    });

    it("denies when no quotas configured", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(null);

      const result = await checkAndIncrementQuota({
        tenantId: TENANT_ID,
        quotaId: "messages_per_day",
        increment: 1,
      });

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0);
    });

    it("uses correct limit for tokens_per_day", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(incrementQuotaBucket).mockResolvedValueOnce({ newValue: 500 });

      const result = await checkAndIncrementQuota({
        tenantId: TENANT_ID,
        quotaId: "tokens_per_day",
        increment: 500,
      });

      expect(result.limit).toBe(1_000_000);
      expect(incrementQuotaBucket).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1_000_000 }),
      );
    });

    it("uses correct limit for cost_per_month", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(incrementQuotaBucket).mockResolvedValueOnce({ newValue: 100 });

      const result = await checkAndIncrementQuota({
        tenantId: TENANT_ID,
        quotaId: "cost_per_month",
        increment: 100,
      });

      expect(result.limit).toBe(50_000);
    });
  });

  describe("checkQuota", () => {
    it("returns allowed when under limit", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(getQuotaBucketValue).mockResolvedValueOnce(500);

      const result = await checkQuota(TENANT_ID, "messages_per_day");
      expect(result.allowed).toBe(true);
      expect(result.currentValue).toBe(500);
    });

    it("returns not allowed when at limit", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(getQuotaBucketValue).mockResolvedValueOnce(1000);

      const result = await checkQuota(TENANT_ID, "messages_per_day");
      expect(result.allowed).toBe(false);
    });
  });

  describe("getQuotaStatus", () => {
    it("returns status for all quota types", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(mockQuotas);
      vi.mocked(getQuotaBucketValue)
        .mockResolvedValueOnce(500) // messages_per_day
        .mockResolvedValueOnce(500_000) // tokens_per_day
        .mockResolvedValueOnce(2500) // cost_per_day
        .mockResolvedValueOnce(25_000); // cost_per_month

      const statuses = await getQuotaStatus(TENANT_ID);

      expect(statuses).toHaveLength(4);
      expect(statuses[0].quotaId).toBe("messages_per_day");
      expect(statuses[0].percentUsed).toBe(50);
      expect(statuses[1].quotaId).toBe("tokens_per_day");
      expect(statuses[1].percentUsed).toBe(50);
    });

    it("returns empty when no quotas configured", async () => {
      vi.mocked(getTenantQuotas).mockResolvedValueOnce(null);
      const statuses = await getQuotaStatus(TENANT_ID);
      expect(statuses).toHaveLength(0);
    });
  });
});
