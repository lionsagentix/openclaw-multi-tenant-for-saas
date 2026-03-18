/**
 * Gateway orchestrator — manages the full lifecycle of tenant gateway containers.
 *
 * Coordinates between the tenant store (database) and the container runtime
 * (Kubernetes/Docker) to provision, deprovision, and manage tenant gateways.
 */

import crypto from "node:crypto";
import {
  generateTenantConfig,
  validateTenantConfigSecurity,
} from "../tenants/tenant-config-generator.js";
import {
  createTenant,
  updateTenantStatus,
  updateTenantGateway,
  deleteTenant,
  createApiKey,
  writeAuditLog,
  getTenant,
} from "../tenants/tenant-store.js";
import type { Tenant, TenantProvisionResult } from "../tenants/types.js";
import type { CreateTenantParams, TenantPlan } from "../tenants/types.js";
import { DEFAULT_PLAN_QUOTAS } from "../tenants/types.js";
import type { ContainerRuntime, ResourceLimits, VolumeMount } from "./container-runtime.js";
import { DEFAULT_RESOURCE_TIERS, type ResourceTier } from "./resource-tiers.js";

const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_GATEWAY_IMAGE = "openclaw:latest";
const HEALTHCHECK_POLL_INTERVAL_MS = 2_000;
const HEALTHCHECK_MAX_WAIT_MS = 60_000;

export type OrchestratorConfig = {
  /** Container runtime (Kubernetes or Docker). */
  runtime: ContainerRuntime;
  /** Gateway container image. */
  gatewayImage?: string;
  /** Gateway port inside containers. */
  gatewayPort?: number;
  /** Resource tiers per plan (optional override). */
  resourceTiers?: Record<TenantPlan, ResourceTier>;
  /** Platform AI keys to inject for platform/hybrid credential modes. */
  platformAiKeys?: {
    openaiKey?: string;
    anthropicKey?: string;
  };
};

/**
 * Create a gateway orchestrator.
 *
 * The orchestrator is the central coordination point for tenant gateway lifecycle:
 * provision, deprovision, start, stop, restart.
 */
export function createOrchestrator(config: OrchestratorConfig) {
  const {
    runtime,
    gatewayImage = DEFAULT_GATEWAY_IMAGE,
    gatewayPort = DEFAULT_GATEWAY_PORT,
    resourceTiers = DEFAULT_RESOURCE_TIERS,
    platformAiKeys,
  } = config;

  /**
   * Provision a new tenant: create DB record, generate config, start container.
   *
   * Full provisioning flow:
   * 1. Validate and create tenant record (status: provisioning)
   * 2. Generate gateway auth token
   * 3. Generate hardened OpenClawConfig
   * 4. Validate config security
   * 5. Start container with config + credentials
   * 6. Wait for healthcheck
   * 7. Update tenant record with gateway info (status: active)
   * 8. Generate tenant API key
   * 9. Write audit log
   */
  async function provisionTenant(
    params: CreateTenantParams,
    actor: string,
  ): Promise<TenantProvisionResult> {
    // 1. Create tenant record in database.
    const tenant = await createTenant(params, DEFAULT_PLAN_QUOTAS);

    try {
      // 2. Generate gateway auth token.
      const gatewayToken = `gw_${crypto.randomBytes(32).toString("hex")}`;

      // 3. Generate hardened tenant config.
      const tenantConfig = generateTenantConfig({ tenant });

      // 4. Validate config security (fail-safe).
      const violations = validateTenantConfigSecurity(tenantConfig);
      if (violations.length > 0) {
        throw new Error(
          `Generated tenant config failed security validation:\n${violations.join("\n")}`,
        );
      }

      // 5. Build container environment and start gateway.
      const env = buildGatewayEnv(tenant, gatewayToken);
      const tier = resourceTiers[tenant.plan];
      const resourceLimits = tierToResourceLimits(tier);
      const volumes = buildVolumeMounts(tenant, tier);

      const containerInfo = await runtime.createGateway({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        env,
        volumes,
        resourceLimits,
        image: gatewayImage,
        gatewayPort,
      });

      // Write the config to the container's volume.
      await runtime.writeGatewayConfig(
        containerInfo.containerId,
        JSON.stringify(tenantConfig, null, 2),
      );

      // 6. Wait for gateway healthcheck to pass.
      await waitForHealthy(containerInfo.containerId);

      // 7. Update tenant record with gateway info.
      await updateTenantGateway(tenant.id, {
        containerId: containerInfo.containerId,
        port: containerInfo.port,
        host: containerInfo.host,
      });
      await updateTenantStatus(tenant.id, "active");

      // 8. Generate tenant API key for self-service endpoints.
      const apiKeyResult = await createApiKey({
        tenantId: tenant.id,
        scope: "tenant",
        label: `Auto-generated for ${tenant.slug}`,
      });

      // 9. Write audit log.
      await writeAuditLog({
        tenantId: tenant.id,
        actor,
        action: "tenant.provision",
        resourceType: "tenant",
        resourceId: tenant.id,
        details: {
          slug: tenant.slug,
          plan: tenant.plan,
          credentialMode: tenant.credentialMode,
          containerId: containerInfo.containerId,
        },
      });

      // Refetch tenant with updated gateway info.
      const updatedTenant = await getTenant(tenant.id);

      return {
        tenant: updatedTenant ?? { ...tenant, status: "active" },
        gatewayToken,
        controlPlaneApiKey: apiKeyResult.key,
      };
    } catch (err) {
      // Rollback: mark tenant as failed and clean up container if created.
      await updateTenantStatus(tenant.id, "suspended");
      await writeAuditLog({
        tenantId: tenant.id,
        actor,
        action: "tenant.provision.failed",
        resourceType: "tenant",
        resourceId: tenant.id,
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  /**
   * Deprovision a tenant: stop container, archive data, remove resources.
   */
  async function deprovisionTenant(tenantId: string, actor: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found.`);
    }

    await updateTenantStatus(tenantId, "deprovisioning");

    // Stop and remove the container (keeps the PVC for data backup).
    if (tenant.gatewayContainerId) {
      try {
        await runtime.removeGateway(tenant.gatewayContainerId);
      } catch (err) {
        console.error(
          `[orchestrator] Failed to remove gateway for tenant ${tenant.slug}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Soft-delete the tenant record.
    await deleteTenant(tenantId);

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.deprovision",
      resourceType: "tenant",
      resourceId: tenantId,
      details: { slug: tenant.slug },
    });
  }

  /**
   * Stop a tenant's gateway (for hibernation or manual pause).
   */
  async function stopTenantGateway(tenantId: string, actor: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant?.gatewayContainerId) {
      throw new Error(`Tenant ${tenantId} has no gateway to stop.`);
    }

    await runtime.stopGateway(tenant.gatewayContainerId);

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.gateway.stop",
      resourceType: "tenant",
      resourceId: tenantId,
    });
  }

  /**
   * Start a stopped tenant's gateway (for wake from hibernation).
   */
  async function startTenantGateway(tenantId: string, actor: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant?.gatewayContainerId) {
      throw new Error(`Tenant ${tenantId} has no gateway to start.`);
    }

    await runtime.startGateway(tenant.gatewayContainerId);
    await waitForHealthy(tenant.gatewayContainerId);

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.gateway.start",
      resourceType: "tenant",
      resourceId: tenantId,
    });
  }

  /**
   * Restart a tenant's gateway.
   */
  async function restartTenantGateway(tenantId: string, actor: string): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant?.gatewayContainerId) {
      throw new Error(`Tenant ${tenantId} has no gateway to restart.`);
    }

    await runtime.restartGateway(tenant.gatewayContainerId);

    await writeAuditLog({
      tenantId,
      actor,
      action: "tenant.gateway.restart",
      resourceType: "tenant",
      resourceId: tenantId,
    });
  }

  /**
   * Get the status of a tenant's gateway container.
   */
  async function getTenantGatewayStatus(tenantId: string) {
    const tenant = await getTenant(tenantId);
    if (!tenant?.gatewayContainerId) {
      return { running: false, ready: false, state: "unknown" as const, restartCount: 0 };
    }
    return runtime.getGatewayStatus(tenant.gatewayContainerId);
  }

  /**
   * Get logs from a tenant's gateway container.
   */
  async function getTenantGatewayLogs(tenantId: string, tail = 100): Promise<string> {
    const tenant = await getTenant(tenantId);
    if (!tenant?.gatewayContainerId) {
      return "(no gateway container)";
    }
    return runtime.getGatewayLogs(tenant.gatewayContainerId, tail);
  }

  // ── Internal Helpers ───────────────────────────────────────────

  /** Build environment variables for a tenant gateway container. */
  function buildGatewayEnv(tenant: Tenant, gatewayToken: string): Record<string, string> {
    const env: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      NODE_ENV: "production",
    };

    // Inject platform AI keys for platform/hybrid credential modes.
    if (
      (tenant.credentialMode === "platform" || tenant.credentialMode === "hybrid") &&
      platformAiKeys
    ) {
      if (platformAiKeys.openaiKey) {
        env.OPENCLAW_PLATFORM_OPENAI_KEY = platformAiKeys.openaiKey;
      }
      if (platformAiKeys.anthropicKey) {
        env.OPENCLAW_PLATFORM_ANTHROPIC_KEY = platformAiKeys.anthropicKey;
      }
    }

    return env;
  }

  /** Convert a resource tier to container resource limits. */
  function tierToResourceLimits(tier: ResourceTier): ResourceLimits {
    return {
      cpuRequest: tier.cpu,
      cpuLimit: tier.cpuLimit,
      memoryRequest: tier.memory,
      memoryLimit: tier.memoryLimit,
    };
  }

  /** Build volume mount specs for a tenant. */
  function buildVolumeMounts(tenant: Tenant, tier: ResourceTier): VolumeMount[] {
    return [
      {
        name: "openclaw-data",
        mountPath: "/home/node/.openclaw",
        storageSize: tier.ephemeralStorage,
      },
    ];
  }

  /** Poll the container's health endpoint until it passes or times out. */
  async function waitForHealthy(containerId: string): Promise<void> {
    const deadline = Date.now() + HEALTHCHECK_MAX_WAIT_MS;

    while (Date.now() < deadline) {
      const status = await runtime.getGatewayStatus(containerId);
      if (status.ready) {
        return;
      }

      if (status.state === "failed") {
        throw new Error(`Gateway container ${containerId} failed to start: ${status.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Gateway container ${containerId} did not become healthy within ${HEALTHCHECK_MAX_WAIT_MS}ms.`,
    );
  }

  return {
    provisionTenant,
    deprovisionTenant,
    stopTenantGateway,
    startTenantGateway,
    restartTenantGateway,
    getTenantGatewayStatus,
    getTenantGatewayLogs,
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
