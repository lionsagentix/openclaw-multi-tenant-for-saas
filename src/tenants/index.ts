/**
 * Tenant management module for the OpenClaw Multi-Tenant SaaS platform.
 *
 * Provides tenant CRUD, slug validation, config generation, and quota management.
 */

export type {
  Tenant,
  TenantId,
  TenantStatus,
  TenantPlan,
  TenantCredentialMode,
  TenantActivityState,
  TenantQuotas,
  CreateTenantParams,
  TenantProvisionResult,
  TenantListParams,
  TenantListResult,
} from "./types.js";

export { DEFAULT_PLAN_QUOTAS } from "./types.js";

export { validateTenantSlug, isValidTenantSlug } from "./tenant-id.js";

export {
  createTenant,
  getTenant,
  getTenantBySlug,
  getTenantQuotas,
  listTenants,
  updateTenantStatus,
  suspendTenant,
  resumeTenant,
  deleteTenant,
  updateTenantGateway,
  recordTenantActivity,
  updateTenantActivityState,
  getIdleTenants,
  createApiKey,
  validateApiKey,
  writeAuditLog,
} from "./tenant-store.js";

export { generateTenantConfig, validateTenantConfigSecurity } from "./tenant-config-generator.js";
