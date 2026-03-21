/**
 * Container runtime abstraction for managing tenant gateway instances.
 *
 * Provides a provider-agnostic interface so the orchestrator can work
 * with Kubernetes (production) or Docker (development) interchangeably.
 */

/** Resource limits applied to a tenant gateway container. */
export type ResourceLimits = {
  /** CPU request (K8s format: "250m", "1000m"). */
  cpuRequest: string;
  /** CPU limit (burst ceiling). */
  cpuLimit: string;
  /** Memory request (K8s format: "128Mi", "512Mi"). */
  memoryRequest: string;
  /** Memory limit (hard cap, OOM kill). */
  memoryLimit: string;
  /** Ephemeral storage limit. */
  ephemeralStorage?: string;
};

/** Volume mount specification. */
export type VolumeMount = {
  /** Name of the volume. */
  name: string;
  /** Mount path inside the container. */
  mountPath: string;
  /** Storage size (K8s format: "1Gi", "10Gi"). */
  storageSize: string;
  /** Storage class name (optional, uses cluster default if omitted). */
  storageClass?: string;
};

/** Container status returned by the runtime. */
export type ContainerStatus = {
  /** Whether the container is currently running. */
  running: boolean;
  /** Whether the container is ready (healthcheck passing). */
  ready: boolean;
  /** Container state description. */
  state: "running" | "pending" | "stopped" | "failed" | "unknown";
  /** Number of restart attempts. */
  restartCount: number;
  /** ISO timestamp of when the container started. */
  startedAt?: string;
  /** Human-readable message (e.g., error reason). */
  message?: string;
};

/** Info returned after creating a gateway container. */
export type ContainerInfo = {
  /** Unique container/pod identifier. */
  containerId: string;
  /** Internal hostname for reaching the gateway. */
  host: string;
  /** Gateway port. */
  port: number;
};

/** Parameters for creating a tenant gateway container. */
export type CreateGatewayParams = {
  /** Tenant ID (used for labeling). */
  tenantId: string;
  /** Tenant slug (used for naming). */
  tenantSlug: string;
  /** Environment variables to inject. */
  env: Record<string, string>;
  /** Volume mounts (typically one for ~/.openclaw). */
  volumes: VolumeMount[];
  /** Resource limits from the tenant's plan tier. */
  resourceLimits: ResourceLimits;
  /** Container image to use. */
  image: string;
  /** Gateway port (default: 18789). */
  gatewayPort?: number;
};

/**
 * Container runtime interface.
 *
 * Implemented by Kubernetes (production) and Docker (development).
 * The orchestrator calls these methods without knowing which backend is active.
 */
export type ContainerRuntime = {
  /** Runtime identifier (for logging/diagnostics). */
  readonly runtimeId: "kubernetes" | "docker";

  /** Create and start a new tenant gateway container. */
  createGateway(params: CreateGatewayParams): Promise<ContainerInfo>;

  /** Stop a running gateway (preserves data volumes). */
  stopGateway(containerId: string): Promise<void>;

  /** Start a previously stopped gateway. */
  startGateway(containerId: string): Promise<void>;

  /** Remove a gateway and its associated resources (except PVC data). */
  removeGateway(containerId: string): Promise<void>;

  /** Get the current status of a gateway container. */
  getGatewayStatus(containerId: string): Promise<ContainerStatus>;

  /** Get recent logs from a gateway container. */
  getGatewayLogs(containerId: string, tail?: number): Promise<string>;

  /** Restart a gateway (stop + start). */
  restartGateway(containerId: string): Promise<void>;

  /**
   * Write a config file to a gateway's data volume.
   * Used for initial provisioning and config updates.
   */
  writeGatewayConfig(containerId: string, configJson: string): Promise<void>;

  /**
   * Write an arbitrary file to a gateway's data volume.
   * Used by credential sync to update auth-profiles.json.
   */
  writeGatewayFile(containerId: string, filePath: string, content: string): Promise<void>;

  /**
   * Read a file from a gateway's data volume.
   * Returns file content as a string, or null if not found.
   * Used by the usage collector to read auth-profiles.json usageStats.
   */
  readGatewayFile(containerId: string, filePath: string): Promise<string | null>;

  /**
   * Delete the persistent data volume for a tenant.
   * Called during tenant deprovisioning after backup.
   */
  deleteGatewayVolume(tenantSlug: string): Promise<void>;
};

/**
 * Factory function type for creating container runtimes.
 * The control plane calls this at startup based on configuration.
 */
export type ContainerRuntimeFactory = (config: {
  /** Kubernetes namespace for tenant resources. */
  namespace?: string;
  /** Docker socket path (for Docker runtime). */
  dockerSocket?: string;
  /** Default container image for gateways. */
  defaultImage: string;
}) => ContainerRuntime;
