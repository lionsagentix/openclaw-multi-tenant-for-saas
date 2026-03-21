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
  getTenant: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock("./billing-provider.js", () => ({
  getProviderForTenant: vi.fn(),
}));

vi.mock("./billing-store.js", () => ({
  insertUsageRecord: vi.fn(),
  getActiveBillingSubscription: vi.fn(),
  getUsageSummary: vi.fn(),
}));

const { getTenant, listTenants } = await import("../tenants/tenant-store.js");
const { getProviderForTenant } = await import("./billing-provider.js");
const { insertUsageRecord, getActiveBillingSubscription, getUsageSummary } =
  await import("./billing-store.js");
const { recordUsage, aggregateAndReportUsage, runUsageReportingCycle } =
  await import("./usage-metering.js");

const TENANT_ID = "tenant-usage-test";

describe("usage-metering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordUsage", () => {
    it("inserts a usage record", async () => {
      vi.mocked(insertUsageRecord).mockResolvedValueOnce(
        {} as ReturnType<typeof insertUsageRecord> extends Promise<infer T> ? T : never,
      );

      await recordUsage({
        tenantId: TENANT_ID,
        date: "2026-03-20",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: 0.03,
        messageCount: 1,
      });

      expect(insertUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, totalTokens: 1500 }),
      );
    });
  });

  describe("aggregateAndReportUsage", () => {
    it("reports usage to billing provider", async () => {
      const mockReportUsage = vi.fn();
      vi.mocked(getTenant).mockResolvedValueOnce({
        id: TENANT_ID,
        slug: "test-tenant",
        credentialMode: "platform",
        status: "active",
      } as Awaited<ReturnType<typeof getTenant>>);

      vi.mocked(getUsageSummary).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        startDate: "2026-03-20",
        endDate: "2026-03-20",
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 1500,
        totalCostUsd: 0.03,
        totalMessages: 1,
      });

      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_123",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });

      vi.mocked(getProviderForTenant).mockResolvedValueOnce({
        name: "stripe",
        reportUsage: mockReportUsage,
      } as unknown as Awaited<ReturnType<typeof getProviderForTenant>>);

      await aggregateAndReportUsage(TENANT_ID, "2026-03-20");

      expect(mockReportUsage).toHaveBeenCalledWith(
        "sub_stripe_123",
        expect.objectContaining({ quantity: 1500 }),
      );
    });

    it("skips BYOK tenants", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce({
        id: TENANT_ID,
        slug: "byok-tenant",
        credentialMode: "byok",
      } as Awaited<ReturnType<typeof getTenant>>);

      await aggregateAndReportUsage(TENANT_ID, "2026-03-20");

      expect(getUsageSummary).not.toHaveBeenCalled();
      expect(getProviderForTenant).not.toHaveBeenCalled();
    });

    it("skips when no usage data", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce({
        id: TENANT_ID,
        slug: "idle-tenant",
        credentialMode: "platform",
      } as Awaited<ReturnType<typeof getTenant>>);

      vi.mocked(getUsageSummary).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        startDate: "2026-03-20",
        endDate: "2026-03-20",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalMessages: 0,
      });

      await aggregateAndReportUsage(TENANT_ID, "2026-03-20");

      expect(getActiveBillingSubscription).not.toHaveBeenCalled();
    });

    it("skips when no active subscription", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce({
        id: TENANT_ID,
        slug: "no-sub-tenant",
        credentialMode: "platform",
      } as Awaited<ReturnType<typeof getTenant>>);

      vi.mocked(getUsageSummary).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        startDate: "2026-03-20",
        endDate: "2026-03-20",
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 150,
        totalCostUsd: 0.01,
        totalMessages: 1,
      });

      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce(null);

      await aggregateAndReportUsage(TENANT_ID, "2026-03-20");

      expect(getProviderForTenant).not.toHaveBeenCalled();
    });
  });

  describe("runUsageReportingCycle", () => {
    it("processes active tenants in batches", async () => {
      vi.mocked(listTenants).mockResolvedValueOnce({
        tenants: [
          { id: "t1", slug: "tenant-1", credentialMode: "platform", status: "active" },
          { id: "t2", slug: "tenant-2", credentialMode: "byok", status: "active" },
        ] as Awaited<ReturnType<typeof listTenants>>["tenants"],
        total: 2,
        limit: 10,
        offset: 0,
      });

      // For the platform tenant (t1).
      vi.mocked(getTenant).mockResolvedValueOnce({
        id: "t1",
        slug: "tenant-1",
        credentialMode: "platform",
      } as Awaited<ReturnType<typeof getTenant>>);

      vi.mocked(getUsageSummary).mockResolvedValueOnce({
        tenantId: "t1",
        startDate: "2026-03-20",
        endDate: "2026-03-20",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalMessages: 0,
      });

      const result = await runUsageReportingCycle("2026-03-20");

      // 1 skipped (byok) in batch loop, 1 processed (platform) even if no usage.
      expect(result.failed).toBe(0);
    });
  });
});
