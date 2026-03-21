import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all dependencies.
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
  getTenantQuotas: vi.fn(),
  resumeTenant: vi.fn(),
  suspendTenant: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("./billing-provider.js", () => ({
  getBillingProvider: vi.fn(),
  getProviderForTenant: vi.fn(),
}));

vi.mock("./billing-store.js", () => ({
  createBillingCustomer: vi.fn(),
  createBillingSubscription: vi.fn(),
  deleteBillingCustomer: vi.fn(),
  getActiveBillingSubscription: vi.fn(),
  getBillingCustomer: vi.fn(),
  updateBillingSubscription: vi.fn(),
}));

vi.mock("./quota-enforcement.js", () => ({
  getQuotaStatus: vi.fn(),
}));

vi.mock("./usage-metering.js", () => ({
  getUsageSummaryForTenant: vi.fn(),
}));

const { getTenant, resumeTenant, suspendTenant, writeAuditLog } =
  await import("../tenants/tenant-store.js");
const { getBillingProvider, getProviderForTenant } = await import("./billing-provider.js");
const {
  createBillingCustomer,
  createBillingSubscription,
  deleteBillingCustomer,
  getActiveBillingSubscription,
  getBillingCustomer,
  updateBillingSubscription,
} = await import("./billing-store.js");
const { getQuotaStatus } = await import("./quota-enforcement.js");
const { getUsageSummaryForTenant } = await import("./usage-metering.js");
const { createBillingLifecycle } = await import("./billing-lifecycle.js");

const TENANT_ID = "tenant-lifecycle-test";

const mockTenant = {
  id: TENANT_ID,
  slug: "test-tenant",
  displayName: "Test Tenant",
  status: "active" as const,
  plan: "pro" as const,
  credentialMode: "platform" as const,
  contactEmail: "test@example.com",
  activityState: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockProvider = {
  name: "stripe" as const,
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  changeSubscriptionPlan: vi.fn(),
  reportUsage: vi.fn(),
  getUpcomingInvoice: vi.fn(),
  listInvoices: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvent: vi.fn(),
};

describe("billing-lifecycle", () => {
  let lifecycle: ReturnType<typeof createBillingLifecycle>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBillingProvider).mockReturnValue(mockProvider);
    vi.mocked(getProviderForTenant).mockResolvedValue(mockProvider);
    lifecycle = createBillingLifecycle({ defaultProvider: "stripe" });
  });

  describe("setupBillingForTenant", () => {
    it("creates customer and subscription at provider and stores records", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce(mockTenant);
      mockProvider.createCustomer.mockResolvedValueOnce({
        externalCustomerId: "cus_new",
      });
      vi.mocked(createBillingCustomer).mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof createBillingCustomer>>,
      );
      mockProvider.createSubscription.mockResolvedValueOnce({
        externalSubscriptionId: "sub_new",
        status: "active",
        currentPeriodStart: "2026-03-20T00:00:00Z",
        currentPeriodEnd: "2026-04-20T00:00:00Z",
      });
      vi.mocked(createBillingSubscription).mockResolvedValueOnce(
        {} as Awaited<ReturnType<typeof createBillingSubscription>>,
      );

      await lifecycle.setupBillingForTenant(TENANT_ID);

      expect(mockProvider.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          email: "test@example.com",
        }),
      );
      expect(createBillingCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          provider: "stripe",
          externalCustomerId: "cus_new",
        }),
      );
      expect(mockProvider.createSubscription).toHaveBeenCalledWith(
        "cus_new",
        expect.objectContaining({ plan: "pro" }),
      );
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "billing.setup" }),
      );
    });

    it("throws when tenant not found", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce(null);
      await expect(lifecycle.setupBillingForTenant("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("changePlan", () => {
    it("changes plan at provider and updates subscription", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce(mockTenant);
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });
      mockProvider.changeSubscriptionPlan.mockResolvedValueOnce({
        status: "active",
        planId: "enterprise",
      });

      await lifecycle.changePlan(TENANT_ID, "enterprise");

      expect(mockProvider.changeSubscriptionPlan).toHaveBeenCalledWith(
        "sub_stripe_1",
        "enterprise",
      );
      expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", {
        planId: "enterprise",
        status: "active",
      });
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "billing.plan_changed" }),
      );
    });
  });

  describe("cancelBilling", () => {
    it("cancels at period end by default", async () => {
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });

      await lifecycle.cancelBilling(TENANT_ID);

      expect(mockProvider.cancelSubscription).toHaveBeenCalledWith(
        "sub_stripe_1",
        expect.objectContaining({ atPeriodEnd: true }),
      );
      expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", {
        cancelAtPeriodEnd: true,
      });
      expect(suspendTenant).not.toHaveBeenCalled();
    });

    it("suspends immediately when atPeriodEnd=false", async () => {
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });

      await lifecycle.cancelBilling(TENANT_ID, false);

      expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", {
        status: "canceled",
      });
      expect(suspendTenant).toHaveBeenCalledWith(TENANT_ID, "Billing canceled");
    });
  });

  describe("handlePaymentSuccess", () => {
    it("resumes suspended tenant", async () => {
      vi.mocked(getTenant).mockResolvedValueOnce({
        ...mockTenant,
        status: "suspended",
      });
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "past_due",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });

      await lifecycle.handlePaymentSuccess(TENANT_ID);

      expect(resumeTenant).toHaveBeenCalledWith(TENANT_ID);
      expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", {
        status: "active",
      });
    });
  });

  describe("teardownBilling", () => {
    it("cancels subscription and deletes customer at provider", async () => {
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });
      vi.mocked(getBillingCustomer).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        provider: "stripe",
        externalCustomerId: "cus_123",
        createdAt: "",
      });

      await lifecycle.teardownBilling(TENANT_ID);

      expect(mockProvider.cancelSubscription).toHaveBeenCalledWith(
        "sub_stripe_1",
        expect.objectContaining({ atPeriodEnd: false }),
      );
      expect(updateBillingSubscription).toHaveBeenCalledWith("sub-1", {
        status: "canceled",
      });
      expect(mockProvider.deleteCustomer).toHaveBeenCalledWith("cus_123");
      expect(deleteBillingCustomer).toHaveBeenCalledWith(TENANT_ID);
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "billing.teardown" }),
      );
    });
  });

  describe("getBillingStatus", () => {
    it("returns combined billing status", async () => {
      vi.mocked(getBillingCustomer).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        provider: "stripe",
        externalCustomerId: "cus_123",
        createdAt: "",
      });
      vi.mocked(getActiveBillingSubscription).mockResolvedValueOnce({
        id: "sub-1",
        tenantId: TENANT_ID,
        provider: "stripe",
        externalSubscriptionId: "sub_stripe_1",
        planId: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        createdAt: "",
        updatedAt: "",
      });
      vi.mocked(getQuotaStatus).mockResolvedValueOnce([
        { quotaId: "messages_per_day", currentValue: 50, limit: 1000, percentUsed: 5 },
      ]);
      vi.mocked(getUsageSummaryForTenant).mockResolvedValueOnce({
        tenantId: TENANT_ID,
        startDate: "2026-03-01",
        endDate: "2026-03-20",
        totalInputTokens: 5000,
        totalOutputTokens: 2500,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 7500,
        totalCostUsd: 0.15,
        totalMessages: 10,
      });

      const status = await lifecycle.getBillingStatus(TENANT_ID);

      expect(status.customer).not.toBeNull();
      expect(status.subscription).not.toBeNull();
      expect(status.quotas).toHaveLength(1);
      expect(status.currentMonthUsage).not.toBeNull();
      expect(status.currentMonthUsage!.totalTokens).toBe(7500);
    });
  });
});
