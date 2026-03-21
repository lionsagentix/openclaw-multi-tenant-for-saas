import { describe, expect, it } from "vitest";
import { createLemonSqueezyProvider } from "./lemonsqueezy.js";

describe("lemonsqueezy provider stub", () => {
  const provider = createLemonSqueezyProvider();

  it("has name 'lemonsqueezy'", () => {
    expect(provider.name).toBe("lemonsqueezy");
  });

  it("createCustomer throws not implemented", async () => {
    await expect(
      provider.createCustomer({ tenantId: "t1", email: "test@test.com" }),
    ).rejects.toThrow("LemonSqueezy billing provider not yet implemented");
  });

  it("getCustomer throws not implemented", async () => {
    await expect(provider.getCustomer("cus_1")).rejects.toThrow("not yet implemented");
  });

  it("deleteCustomer throws not implemented", async () => {
    await expect(provider.deleteCustomer("cus_1")).rejects.toThrow("not yet implemented");
  });

  it("createSubscription throws not implemented", async () => {
    await expect(
      provider.createSubscription("cus_1", { tenantId: "t1", plan: "pro" }),
    ).rejects.toThrow("not yet implemented");
  });

  it("cancelSubscription throws not implemented", async () => {
    await expect(provider.cancelSubscription("sub_1", { tenantId: "t1" })).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("changeSubscriptionPlan throws not implemented", async () => {
    await expect(provider.changeSubscriptionPlan("sub_1", "pro")).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("reportUsage throws not implemented", async () => {
    await expect(provider.reportUsage("sub_1", { quantity: 100 })).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("getUpcomingInvoice throws not implemented", async () => {
    await expect(provider.getUpcomingInvoice("cus_1")).rejects.toThrow("not yet implemented");
  });

  it("listInvoices throws not implemented", async () => {
    await expect(
      provider.listInvoices({ tenantId: "t1", externalCustomerId: "cus_1" }),
    ).rejects.toThrow("not yet implemented");
  });

  it("verifyWebhookSignature throws not implemented", async () => {
    await expect(provider.verifyWebhookSignature(Buffer.from(""), "", "")).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("parseWebhookEvent throws not implemented", async () => {
    await expect(provider.parseWebhookEvent(Buffer.from(""))).rejects.toThrow(
      "not yet implemented",
    );
  });
});
