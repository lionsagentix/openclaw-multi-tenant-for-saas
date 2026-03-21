/**
 * API request/response types for the control plane REST API.
 *
 * Defines typed request extensions, error shapes, and request body
 * types for admin and tenant self-service endpoints.
 */

import type { Request } from "express";
import type { TenantCredentialMode, TenantPlan } from "../../tenants/types.js";

// ── Auth Context ────────────────────────────────────────────────

/** Authentication context attached to requests by the auth middleware. */
export type AuthContext = {
  /** Tenant ID associated with the API key (null for admin-only keys). */
  tenantId: string | null;
  /** API key scope: "admin" for platform operators, "tenant" for self-service. */
  scope: "admin" | "tenant";
  /** ID of the API key record (for audit logging). */
  keyId: string;
};

/** Express Request with attached auth context. */
export type AuthenticatedRequest = Request & {
  auth: AuthContext;
};

// ── Error Response ──────────────────────────────────────────────

/** Standard JSON error response shape. */
export type ApiErrorResponse = {
  error: {
    message: string;
    type: "validation_error" | "not_found" | "unauthorized" | "forbidden" | "internal_error";
    details?: unknown;
  };
};

// ── Admin Request Bodies ────────────────────────────────────────

/** POST /api/v1/tenants — create a new tenant. */
export type CreateTenantBody = {
  slug: string;
  displayName: string;
  plan: TenantPlan;
  credentialMode: TenantCredentialMode;
  contactEmail: string;
  metadata?: Record<string, string>;
};

/** PATCH /api/v1/tenants/:id — update a tenant. */
export type UpdateTenantBody = {
  displayName?: string;
  plan?: TenantPlan;
  credentialMode?: TenantCredentialMode;
  contactEmail?: string;
  metadata?: Record<string, string>;
};

/** POST /api/v1/tenants/:id/suspend — suspend with optional reason. */
export type SuspendTenantBody = {
  reason?: string;
};

// ── Tenant Self-Service Request Bodies ──────────────────────────

/** POST /api/v1/tenant/credentials — upload a BYOK API key. */
export type CreateCredentialBody = {
  provider: string;
  apiKey: string;
  label?: string;
};

// ── Pagination Query Params ─────────────────────────────────────

/** GET /api/v1/tenants query parameters. */
export type ListTenantsQuery = {
  status?: string;
  plan?: string;
  search?: string;
  limit?: string;
  offset?: string;
};
