/**
 * LemonSqueezy billing provider stub.
 *
 * Implements the BillingProvider interface with placeholder methods
 * that throw "not yet implemented" errors. This ensures type safety
 * while marking LemonSqueezy integration as a future milestone.
 */

import type { BillingProvider } from "../billing-provider.js";

const NOT_IMPLEMENTED = "LemonSqueezy billing provider not yet implemented";

export function createLemonSqueezyProvider(): BillingProvider {
  return {
    name: "lemonsqueezy",

    async createCustomer() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async getCustomer() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async deleteCustomer() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async createSubscription() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async cancelSubscription() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async changeSubscriptionPlan() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async reportUsage() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async getUpcomingInvoice() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async listInvoices() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async verifyWebhookSignature() {
      throw new Error(NOT_IMPLEMENTED);
    },

    async parseWebhookEvent() {
      throw new Error(NOT_IMPLEMENTED);
    },
  };
}
