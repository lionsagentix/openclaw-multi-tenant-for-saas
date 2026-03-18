/**
 * Tenant lifecycle coordinator.
 *
 * High-level operations that combine tenant store (database), orchestrator
 * (container management), and proxy router (traffic routing) into complete
 * lifecycle workflows.
 *
 * This is the primary API that the control plane server calls for tenant
 * management operations.
 */

import type { Orchestrator } from "../control-plane/orchestrator.js";
import type { ProxyRouter } from "../control-plane/proxy-router.js";
import {
  getTenant,
  getTenantBySlug,
  getTenantQuotas,
  listTenants,
  resumeTenant,
  updateTenantStatus,
  writeAuditLog,
} from "./tenant-store.js";
import type {
  CreateTenantParams,
  Tenant,
  TenantId,
  TenantListParams,
  TenantListResult,
  TenantProvisionResult,
  TenantQuotas,
} from "./types.js";

export type TenantLifecycleConfig = {
  orchestrator: Orchestrator;
  proxyRouter: ProxyRouter;
};

/**
 * Create a tenant lifecycle coordinator.
 *
 * Provides the high-level operations used by the control plane API.
 */
export function createTenantLifecycle(config: TenantLifecycleConfig) {
  const { orchestrator, proxyRouter } = config;

  /**
   * Create and provision a new tenant (full flow).
   *
   * 1. Creates tenant record
   * 2. Provisions gateway container
   * 3. Waits for healthcheck
   * 4. Updates proxy routing table
   * 5. Returns tenant credentials
   */
  async function createAndProvision(
    params: CreateTenantParams,
    actor: string,
  ): Promise<TenantProvisionResult> {
    const result = await orchestrator.provisionTenant(params, actor);

    // Update the proxy routing table.
    await proxyRouter.refresh();

    return result;
  }

  /**
   * Suspend a tenant.
   *
   * Stops the gateway and removes from routing.
   * Tenant data is preserved for resumption.
   */
  async function suspend(
    tenantId: TenantId,
    reason: string,
    actor: string,
  ): Promise<Tenant | null> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return null;
    }

    // Stop the gateway container.
    try {
      await orchestrator.stopTenantGateway(tenantId, actor);
    } catch (err) {
      console.error(
        `[tenant-lifecycle] Error stopping gateway for ${tenant.slug}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Update status in database.
    await updateTenantStatus(tenantId, "suspended");

    // Remove from routing.
    proxyRouter.setHealth(tenant.slug, false);

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.suspend",
      resourceType: "tenant",
      resourceId: tenantId,
      details: { reason },
    });

    return getTenant(tenantId);
  }

  /**
   * Resume a suspended tenant.
   *
   * Restarts the gateway and restores routing.
   */
  async function resume(tenantId: TenantId, actor: string): Promise<Tenant | null> {
    const tenant = await getTenant(tenantId);
    if (!tenant || tenant.status !== "suspended") {
      return null;
    }

    // Resume in database.
    await resumeTenant(tenantId);

    // Start the gateway container.
    try {
      await orchestrator.startTenantGateway(tenantId, actor);
    } catch (err) {
      // If start fails, re-suspend.
      await updateTenantStatus(tenantId, "suspended");
      throw err;
    }

    // Restore routing.
    await proxyRouter.refresh();

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.resume",
      resourceType: "tenant",
      resourceId: tenantId,
    });

    return getTenant(tenantId);
  }

  /**
   * Permanently delete a tenant.
   *
   * Stops gateway, removes container, soft-deletes records.
   * PVC data is preserved for backup/compliance.
   */
  async function remove(tenantId: TenantId, actor: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found.`);
    }

    await orchestrator.deprovisionTenant(tenantId, actor);

    // Remove from routing.
    proxyRouter.setHealth(tenant.slug, false);
    await proxyRouter.refresh();
  }

  /**
   * Get tenant details with gateway status.
   */
  async function getDetails(tenantId: TenantId): Promise<{
    tenant: Tenant;
    quotas: TenantQuotas | null;
    gatewayStatus: Awaited<ReturnType<Orchestrator["getTenantGatewayStatus"]>>;
  } | null> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      return null;
    }

    const [quotas, gatewayStatus] = await Promise.all([
      getTenantQuotas(tenantId),
      orchestrator.getTenantGatewayStatus(tenantId),
    ]);

    return { tenant, quotas, gatewayStatus };
  }

  /**
   * Get tenant details by slug.
   */
  async function getBySlug(slug: string): Promise<Tenant | null> {
    return getTenantBySlug(slug);
  }

  /**
   * List tenants with filtering and pagination.
   */
  async function list(params: TenantListParams): Promise<TenantListResult> {
    return listTenants(params);
  }

  /**
   * Restart a tenant's gateway.
   */
  async function restartGateway(tenantId: TenantId, actor: string): Promise<void> {
    await orchestrator.restartTenantGateway(tenantId, actor);
  }

  /**
   * Get gateway logs for a tenant.
   */
  async function getGatewayLogs(tenantId: TenantId, tail = 100): Promise<string> {
    return orchestrator.getTenantGatewayLogs(tenantId, tail);
  }

  return {
    createAndProvision,
    suspend,
    resume,
    remove,
    getDetails,
    getBySlug,
    list,
    restartGateway,
    getGatewayLogs,
  };
}

export type TenantLifecycle = ReturnType<typeof createTenantLifecycle>;
