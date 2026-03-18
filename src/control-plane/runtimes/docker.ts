/**
 * Docker container runtime implementation.
 *
 * Development/fallback runtime for local testing and small deployments.
 * Manages tenant gateway containers via the Docker Engine API.
 */

import Dockerode from "dockerode";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerStatus,
  CreateGatewayParams,
} from "../container-runtime.js";

const DEFAULT_GATEWAY_PORT = 18789;
const CONTAINER_STOP_TIMEOUT = 30; // seconds

export type DockerRuntimeConfig = {
  /** Docker socket path. Default: /var/run/docker.sock */
  socketPath?: string;
  /** Default container image for tenant gateways. */
  defaultImage: string;
  /** Docker network to attach tenant containers to. */
  networkName?: string;
};

/**
 * Create a Docker-backed container runtime.
 * Uses the Docker Engine API via dockerode.
 */
export function createDockerRuntime(config: DockerRuntimeConfig): ContainerRuntime {
  const docker = new Dockerode({
    socketPath: config.socketPath ?? "/var/run/docker.sock",
  });

  const networkName = config.networkName ?? "openclaw-tenants";

  /** Build a consistent container name from tenant slug. */
  function containerName(tenantSlug: string): string {
    return `openclaw-gw-${tenantSlug}`;
  }

  function volumeName(tenantSlug: string): string {
    return `openclaw-tenant-${tenantSlug}-data`;
  }

  /** Ensure the tenant network exists. */
  async function ensureNetwork(): Promise<void> {
    try {
      const network = docker.getNetwork(networkName);
      await network.inspect();
    } catch {
      await docker.createNetwork({ Name: networkName, Driver: "bridge" });
    }
  }

  const runtime: ContainerRuntime = {
    runtimeId: "docker",

    async createGateway(params: CreateGatewayParams): Promise<ContainerInfo> {
      const {
        tenantId,
        tenantSlug,
        env,
        volumes,
        resourceLimits,
        image,
        gatewayPort = DEFAULT_GATEWAY_PORT,
      } = params;

      await ensureNetwork();

      const name = containerName(tenantSlug);
      const vol = volumes[0];
      const volName = volumeName(tenantSlug);

      // Create volume if needed.
      if (vol) {
        try {
          await docker.createVolume({ Name: volName });
        } catch {
          // Volume may already exist (e.g., after hibernation).
        }
      }

      // Build environment array.
      const envArray = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "HOME=/home/node"];

      // Parse memory limit for Docker (convert K8s format to bytes).
      const memoryBytes = parseK8sMemory(resourceLimits.memoryLimit);
      const cpuNanos = parseK8sCpu(resourceLimits.cpuLimit);

      const container = await docker.createContainer({
        name,
        Image: image,
        Cmd: [
          "node",
          "openclaw.mjs",
          "gateway",
          "run",
          "--bind",
          "lan",
          "--port",
          String(gatewayPort),
        ],
        Env: envArray,
        Labels: {
          "openclaw.tenant-id": tenantId,
          "openclaw.tenant-slug": tenantSlug,
          "openclaw.component": "tenant-gateway",
        },
        ExposedPorts: { [`${gatewayPort}/tcp`]: {} },
        HostConfig: {
          Binds: vol ? [`${volName}:${vol.mountPath}`] : [],
          NetworkMode: networkName,
          Memory: memoryBytes || undefined,
          NanoCpus: cpuNanos || undefined,
          RestartPolicy: { Name: "unless-stopped" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
        Healthcheck: {
          Test: [
            "CMD-SHELL",
            `node -e "fetch('http://127.0.0.1:${gatewayPort}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
          ],
          Interval: 180_000_000_000, // 3 min in nanoseconds
          Timeout: 10_000_000_000, // 10 sec
          StartPeriod: 15_000_000_000, // 15 sec
          Retries: 3,
        },
        User: "1000", // node user (non-root)
      });

      await container.start();

      // Get the container's IP on the tenant network.
      const info = await container.inspect();
      const networkSettings = info.NetworkSettings?.Networks?.[networkName];
      const host = networkSettings?.IPAddress ?? "127.0.0.1";

      return {
        containerId: name,
        host,
        port: gatewayPort,
      };
    },

    async stopGateway(containerId: string): Promise<void> {
      const container = docker.getContainer(containerId);
      try {
        await container.stop({ t: CONTAINER_STOP_TIMEOUT });
      } catch (err: unknown) {
        // Ignore "container already stopped" errors.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("is not running") && !message.includes("304")) {
          throw err;
        }
      }
    },

    async startGateway(containerId: string): Promise<void> {
      const container = docker.getContainer(containerId);
      await container.start();
    },

    async removeGateway(containerId: string): Promise<void> {
      const container = docker.getContainer(containerId);
      try {
        await container.stop({ t: CONTAINER_STOP_TIMEOUT });
      } catch {
        // May already be stopped.
      }
      await container.remove({ force: true });
      // Volume is NOT removed here — use deleteGatewayVolume() for that.
    },

    async getGatewayStatus(containerId: string): Promise<ContainerStatus> {
      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const dockerState = info.State;

        let state: ContainerStatus["state"] = "unknown";
        if (dockerState?.Running) {
          state = "running";
        } else if (dockerState?.Status === "exited" || dockerState?.Status === "dead") {
          state = dockerState.ExitCode === 0 ? "stopped" : "failed";
        } else if (dockerState?.Status === "created" || dockerState?.Status === "restarting") {
          state = "pending";
        }

        const health = dockerState?.Health;
        const ready = health?.Status === "healthy" || (state === "running" && !health);

        return {
          running: state === "running",
          ready,
          state,
          restartCount: dockerState?.RestartCount ?? 0,
          startedAt: dockerState?.StartedAt ?? undefined,
          message: dockerState?.Error || undefined,
        };
      } catch {
        return {
          running: false,
          ready: false,
          state: "unknown",
          restartCount: 0,
          message: "Container not found.",
        };
      }
    },

    async getGatewayLogs(containerId: string, tail = 100): Promise<string> {
      const container = docker.getContainer(containerId);
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      return typeof logs === "string" ? logs : logs.toString("utf-8");
    },

    async restartGateway(containerId: string): Promise<void> {
      const container = docker.getContainer(containerId);
      await container.restart({ t: CONTAINER_STOP_TIMEOUT });
    },

    async writeGatewayConfig(containerId: string, configJson: string): Promise<void> {
      // Write config by executing a command inside the container.
      // The config file is at /home/node/.openclaw/openclaw.json.
      const container = docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: [
          "sh",
          "-c",
          `mkdir -p /home/node/.openclaw && cat > /home/node/.openclaw/openclaw.json`,
        ],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: true });
      stream.write(configJson);
      stream.end();
    },

    async deleteGatewayVolume(tenantSlug: string): Promise<void> {
      try {
        const volume = docker.getVolume(volumeName(tenantSlug));
        await volume.remove();
      } catch {
        // Volume may not exist.
      }
    },
  };

  return runtime;
}

// ── K8s format parsers ─────────────────────────────────────────

/** Parse K8s memory format ("128Mi", "1Gi") to bytes. */
function parseK8sMemory(value: string): number | undefined {
  const match = /^(\d+)(Mi|Gi|Ki)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const num = Number(match[1]);
  switch (match[2]) {
    case "Ki":
      return num * 1024;
    case "Mi":
      return num * 1024 * 1024;
    case "Gi":
      return num * 1024 * 1024 * 1024;
    default:
      return num;
  }
}

/** Parse K8s CPU format ("250m", "1000m", "2") to nanoseconds. */
function parseK8sCpu(value: string): number | undefined {
  const match = /^(\d+)(m)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const num = Number(match[1]);
  if (match[2] === "m") {
    return num * 1_000_000; // millicores to nanoseconds
  }
  return num * 1_000_000_000; // cores to nanoseconds
}
