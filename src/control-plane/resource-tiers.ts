/**
 * Per-plan resource tiers for tenant gateway containers.
 *
 * Defines CPU, memory, storage, and hibernation policy per billing plan.
 * Used by the orchestrator to set container resource limits.
 */

import type { TenantPlan } from "../tenants/types.js";

/** Resource tier defining container limits and hibernation behavior per plan. */
export type ResourceTier = {
  planId: TenantPlan;
  /** CPU request (K8s format). */
  cpu: string;
  /** CPU limit (burst ceiling). */
  cpuLimit: string;
  /** Memory request. */
  memory: string;
  /** Memory limit (hard cap, OOM kill). */
  memoryLimit: string;
  /** Ephemeral/persistent storage size. */
  ephemeralStorage: string;
  /** Hibernation policy for this tier. */
  hibernation: {
    /** If true, this tier is never hibernated. */
    exempt: boolean;
    /** Minutes of inactivity before marking as idle. */
    idleMinutes: number;
    /** Minutes of idle before hibernating (stopping container). */
    hibernateMinutes: number;
  };
};

/** Default resource tiers per plan. */
export const DEFAULT_RESOURCE_TIERS: Record<TenantPlan, ResourceTier> = {
  free: {
    planId: "free",
    cpu: "250m",
    cpuLimit: "500m",
    memory: "128Mi",
    memoryLimit: "256Mi",
    ephemeralStorage: "1Gi",
    hibernation: { exempt: false, idleMinutes: 15, hibernateMinutes: 30 },
  },
  starter: {
    planId: "starter",
    cpu: "500m",
    cpuLimit: "1000m",
    memory: "256Mi",
    memoryLimit: "512Mi",
    ephemeralStorage: "5Gi",
    hibernation: { exempt: false, idleMinutes: 30, hibernateMinutes: 120 },
  },
  pro: {
    planId: "pro",
    cpu: "1000m",
    cpuLimit: "2000m",
    memory: "512Mi",
    memoryLimit: "1Gi",
    ephemeralStorage: "10Gi",
    hibernation: { exempt: false, idleMinutes: 60, hibernateMinutes: 240 },
  },
  enterprise: {
    planId: "enterprise",
    cpu: "2000m",
    cpuLimit: "4000m",
    memory: "2Gi",
    memoryLimit: "4Gi",
    ephemeralStorage: "20Gi",
    hibernation: { exempt: true, idleMinutes: 0, hibernateMinutes: 0 },
  },
};
