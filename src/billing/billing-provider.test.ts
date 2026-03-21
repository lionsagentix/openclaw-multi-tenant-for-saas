import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingProvider } from "./billing-provider.js";
import {
  clearProviderRegistry,
  getBillingProvider,
  getProviderForTenant,
  getRegisteredProviders,
  registerBillingProvider,
} from "./billing-provider.js";

// Mock billing-store so getProviderForTenant can resolve.
vi.mock("./billing-store.js", () => ({
  getBillingCustomer: vi.fn(),
}));

const { getBillingCustomer } = await import("./billing-store.js");

function createMockProvider(name: "stripe" | "paddle" | "lemonsqueezy"): BillingProvider {
  return {
    name,
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
}

describe("billing-provider registry", () => {
  beforeEach(() => {
    clearProviderRegistry();
  });

  it("registers and retrieves a provider", () => {
    const stripe = createMockProvider("stripe");
    registerBillingProvider(stripe);

    const retrieved = getBillingProvider("stripe");
    expect(retrieved).toBe(stripe);
  });

  it("throws when getting an unregistered provider", () => {
    expect(() => getBillingProvider("stripe")).toThrow(
      'Billing provider "stripe" is not registered',
    );
  });

  it("lists all registered providers", () => {
    registerBillingProvider(createMockProvider("stripe"));
    registerBillingProvider(createMockProvider("paddle"));

    const names = getRegisteredProviders();
    expect(names).toContain("stripe");
    expect(names).toContain("paddle");
    expect(names).toHaveLength(2);
  });

  it("overwrites a provider with the same name", () => {
    const stripe1 = createMockProvider("stripe");
    const stripe2 = createMockProvider("stripe");

    registerBillingProvider(stripe1);
    registerBillingProvider(stripe2);

    expect(getBillingProvider("stripe")).toBe(stripe2);
    expect(getRegisteredProviders()).toHaveLength(1);
  });

  it("clears all providers", () => {
    registerBillingProvider(createMockProvider("stripe"));
    registerBillingProvider(createMockProvider("paddle"));

    clearProviderRegistry();

    expect(getRegisteredProviders()).toHaveLength(0);
    expect(() => getBillingProvider("stripe")).toThrow();
  });

  describe("getProviderForTenant", () => {
    it("returns provider matching tenant's billing customer record", async () => {
      const paddle = createMockProvider("paddle");
      registerBillingProvider(createMockProvider("stripe"));
      registerBillingProvider(paddle);

      vi.mocked(getBillingCustomer).mockResolvedValueOnce({
        tenantId: "tenant-1",
        provider: "paddle",
        externalCustomerId: "cus_paddle_1",
        createdAt: new Date().toISOString(),
      });

      const provider = await getProviderForTenant("tenant-1");
      expect(provider).toBe(paddle);
    });

    it("falls back to default provider when no billing customer exists", async () => {
      const stripe = createMockProvider("stripe");
      registerBillingProvider(stripe);

      vi.mocked(getBillingCustomer).mockResolvedValueOnce(null);

      const provider = await getProviderForTenant("tenant-no-customer");
      expect(provider).toBe(stripe);
    });
  });
});
