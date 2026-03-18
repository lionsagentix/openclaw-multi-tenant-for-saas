/**
 * Kubernetes container runtime implementation.
 *
 * Primary runtime for production deployments (500+ tenants).
 * Manages tenant gateway pods via the Kubernetes API.
 *
 * Resources created per tenant:
 * - Deployment (1 replica, resource limits from plan tier)
 * - PersistentVolumeClaim (for ~/.openclaw data)
 * - Service (ClusterIP for internal routing)
 * - NetworkPolicy (restricts egress to AI APIs + control plane)
 * - Secret (gateway token, platform AI keys)
 */

import * as k8s from "@kubernetes/client-node";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerStatus,
  CreateGatewayParams,
} from "../container-runtime.js";

const DEFAULT_NAMESPACE = "openclaw";
const DEFAULT_GATEWAY_PORT = 18789;
const HEALTHCHECK_INITIAL_DELAY = 15;
const HEALTHCHECK_PERIOD = 180;

export type KubernetesRuntimeConfig = {
  /** Kubernetes namespace for all tenant resources. Default: "openclaw". */
  namespace?: string;
  /** Default container image for tenant gateways. */
  defaultImage: string;
};

/**
 * Create a Kubernetes-backed container runtime.
 * Uses the in-cluster config when running inside K8s, or kubeconfig for local dev.
 */
export function createKubernetesRuntime(config: KubernetesRuntimeConfig): ContainerRuntime {
  const kc = new k8s.KubeConfig();

  // Detect environment: in-cluster (pod) vs local (kubeconfig).
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }

  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

  const namespace = config.namespace ?? DEFAULT_NAMESPACE;

  /** Build a consistent resource name from tenant slug. */
  function gatewayName(tenantSlug: string): string {
    return `openclaw-gw-${tenantSlug}`;
  }

  function pvcName(tenantSlug: string): string {
    return `openclaw-tenant-${tenantSlug}-data`;
  }

  function secretName(tenantSlug: string): string {
    return `openclaw-tenant-${tenantSlug}-secrets`;
  }

  function serviceName(tenantSlug: string): string {
    return `openclaw-gw-${tenantSlug}`;
  }

  function netpolName(tenantSlug: string): string {
    return `openclaw-tenant-${tenantSlug}-netpol`;
  }

  /** Standard labels applied to all tenant resources. */
  function tenantLabels(tenantId: string, tenantSlug: string): Record<string, string> {
    return {
      app: "openclaw-gateway",
      component: "tenant-gateway",
      "tenant-id": tenantId,
      "tenant-slug": tenantSlug,
    };
  }

  const runtime: ContainerRuntime = {
    runtimeId: "kubernetes",

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
      const labels = tenantLabels(tenantId, tenantSlug);
      const name = gatewayName(tenantSlug);

      // 1. Create Secret with env vars (gateway token, AI keys).
      const secretData: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        secretData[key] = Buffer.from(value).toString("base64");
      }

      await coreApi.createNamespacedSecret({
        namespace,
        body: {
          metadata: { name: secretName(tenantSlug), namespace, labels },
          type: "Opaque",
          data: secretData,
        },
      });

      // 2. Create PVC for tenant data.
      const vol = volumes[0]; // Primary data volume.
      if (vol) {
        await coreApi.createNamespacedPersistentVolumeClaim({
          namespace,
          body: {
            metadata: { name: pvcName(tenantSlug), namespace, labels },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: vol.storageSize } },
              ...(vol.storageClass ? { storageClassName: vol.storageClass } : {}),
            },
          },
        });
      }

      // 3. Create Deployment.
      const envVars: k8s.V1EnvVar[] = Object.keys(env).map((key) => ({
        name: key,
        valueFrom: {
          secretKeyRef: { name: secretName(tenantSlug), key },
        },
      }));
      // Add HOME so the gateway writes to the mounted volume.
      envVars.push({ name: "HOME", value: "/home/node" });

      await appsApi.createNamespacedDeployment({
        namespace,
        body: {
          metadata: { name, namespace, labels },
          spec: {
            replicas: 1,
            strategy: { type: "Recreate" },
            selector: { matchLabels: { app: "openclaw-gateway", "tenant-id": tenantId } },
            template: {
              metadata: { labels },
              spec: {
                containers: [
                  {
                    name: "gateway",
                    image,
                    args: [
                      "node",
                      "openclaw.mjs",
                      "gateway",
                      "run",
                      "--bind",
                      "lan",
                      "--port",
                      String(gatewayPort),
                    ],
                    ports: [{ name: "gateway", containerPort: gatewayPort, protocol: "TCP" }],
                    env: envVars,
                    resources: {
                      requests: {
                        cpu: resourceLimits.cpuRequest,
                        memory: resourceLimits.memoryRequest,
                      },
                      limits: {
                        cpu: resourceLimits.cpuLimit,
                        memory: resourceLimits.memoryLimit,
                      },
                    },
                    volumeMounts: vol ? [{ name: "openclaw-data", mountPath: vol.mountPath }] : [],
                    livenessProbe: {
                      httpGet: {
                        path: "/healthz",
                        port: gatewayPort as unknown as k8s.IntOrString,
                      },
                      initialDelaySeconds: HEALTHCHECK_INITIAL_DELAY,
                      periodSeconds: HEALTHCHECK_PERIOD,
                      timeoutSeconds: 10,
                    },
                    readinessProbe: {
                      httpGet: { path: "/readyz", port: gatewayPort as unknown as k8s.IntOrString },
                      initialDelaySeconds: 5,
                      periodSeconds: 10,
                      timeoutSeconds: 3,
                    },
                    securityContext: {
                      runAsNonRoot: true,
                      runAsUser: 1000,
                      allowPrivilegeEscalation: false,
                      capabilities: { drop: ["ALL"] },
                    },
                  },
                ],
                volumes: vol
                  ? [
                      {
                        name: "openclaw-data",
                        persistentVolumeClaim: { claimName: pvcName(tenantSlug) },
                      },
                    ]
                  : [],
              },
            },
          },
        },
      });

      // 4. Create Service.
      await coreApi.createNamespacedService({
        namespace,
        body: {
          metadata: { name: serviceName(tenantSlug), namespace, labels },
          spec: {
            type: "ClusterIP",
            ports: [
              {
                name: "gateway",
                port: gatewayPort,
                targetPort: gatewayPort as unknown as k8s.IntOrString,
                protocol: "TCP",
              },
            ],
            selector: { app: "openclaw-gateway", "tenant-id": tenantId },
          },
        },
      });

      // 5. Create NetworkPolicy (tenant isolation).
      await networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body: {
          metadata: { name: netpolName(tenantSlug), namespace, labels },
          spec: {
            podSelector: { matchLabels: { app: "openclaw-gateway", "tenant-id": tenantId } },
            policyTypes: ["Ingress", "Egress"],
            ingress: [
              {
                from: [{ podSelector: { matchLabels: { app: "openclaw-control-plane" } } }],
              },
            ],
            egress: [
              // DNS.
              {
                ports: [
                  { protocol: "UDP", port: 53 },
                  { protocol: "TCP", port: 53 },
                ],
              },
              // HTTPS (AI provider APIs).
              {
                to: [
                  {
                    ipBlock: {
                      cidr: "0.0.0.0/0",
                      except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
                    },
                  },
                ],
                ports: [{ protocol: "TCP", port: 443 }],
              },
              // Control plane.
              {
                to: [{ podSelector: { matchLabels: { app: "openclaw-control-plane" } } }],
                ports: [{ protocol: "TCP", port: 8080 }],
              },
            ],
          },
        },
      });

      return {
        containerId: name,
        host: `${serviceName(tenantSlug)}.${namespace}.svc.cluster.local`,
        port: gatewayPort,
      };
    },

    async stopGateway(containerId: string): Promise<void> {
      // Scale deployment to 0 replicas (preserves PVC).
      await appsApi.patchNamespacedDeployment({
        name: containerId,
        namespace,
        body: { spec: { replicas: 0 } },
      });
    },

    async startGateway(containerId: string): Promise<void> {
      // Scale deployment back to 1 replica.
      await appsApi.patchNamespacedDeployment({
        name: containerId,
        namespace,
        body: { spec: { replicas: 1 } },
      });
    },

    async removeGateway(containerId: string): Promise<void> {
      // Extract tenant slug from containerId (format: "openclaw-gw-{slug}").
      const slug = containerId.replace(/^openclaw-gw-/, "");

      // Delete in reverse order: netpol, service, deployment, secret.
      // PVC is kept for data backup; use deleteGatewayVolume() to remove it.
      const deleteOpts = { gracePeriodSeconds: 30 };

      try {
        await networkingApi.deleteNamespacedNetworkPolicy({ name: netpolName(slug), namespace });
      } catch {
        /* may not exist */
      }
      try {
        await coreApi.deleteNamespacedService({ name: serviceName(slug), namespace });
      } catch {
        /* may not exist */
      }
      try {
        await appsApi.deleteNamespacedDeployment({ name: containerId, namespace, ...deleteOpts });
      } catch {
        /* may not exist */
      }
      try {
        await coreApi.deleteNamespacedSecret({ name: secretName(slug), namespace });
      } catch {
        /* may not exist */
      }
    },

    async getGatewayStatus(containerId: string): Promise<ContainerStatus> {
      try {
        const response = await appsApi.readNamespacedDeployment({ name: containerId, namespace });
        const deployment = response;
        const status = deployment.status;

        const replicas = status?.replicas ?? 0;
        const readyReplicas = status?.readyReplicas ?? 0;
        const availableReplicas = status?.availableReplicas ?? 0;

        let state: ContainerStatus["state"] = "unknown";
        if (replicas === 0) {
          state = "stopped";
        } else if (readyReplicas > 0 && availableReplicas > 0) {
          state = "running";
        } else if (replicas > 0) {
          state = "pending";
        }

        // Check for pod-level failures.
        const conditions = status?.conditions ?? [];
        const failedCondition = conditions.find(
          (c) => c.type === "Available" && c.status === "False",
        );

        if (failedCondition && state === "pending") {
          state = "failed";
        }

        return {
          running: state === "running",
          ready: readyReplicas > 0,
          state,
          restartCount: 0, // Would need pod-level query for accurate restart count.
          startedAt: undefined,
          message: failedCondition?.message ?? undefined,
        };
      } catch {
        return {
          running: false,
          ready: false,
          state: "unknown",
          restartCount: 0,
          message: "Failed to query deployment status.",
        };
      }
    },

    async getGatewayLogs(containerId: string, tail = 100): Promise<string> {
      const slug = containerId.replace(/^openclaw-gw-/, "");

      // Find the pod for this deployment.
      const pods = await coreApi.listNamespacedPod({
        namespace,
        labelSelector: `app=openclaw-gateway,tenant-slug=${slug}`,
      });

      if (!pods.items || pods.items.length === 0) {
        return "(no pods found)";
      }

      const podName = pods.items[0].metadata?.name;
      if (!podName) {
        return "(pod name not available)";
      }

      const logResponse = await coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines: tail,
      });

      return typeof logResponse === "string" ? logResponse : String(logResponse);
    },

    async restartGateway(containerId: string): Promise<void> {
      // Trigger a rollout restart by patching the deployment template annotation.
      await appsApi.patchNamespacedDeployment({
        name: containerId,
        namespace,
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "openclaw.ai/restart-trigger": new Date().toISOString(),
                },
              },
            },
          },
        },
      });
    },

    async writeGatewayConfig(containerId: string, configJson: string): Promise<void> {
      const slug = containerId.replace(/^openclaw-gw-/, "");
      const configMapName = `openclaw-tenant-${slug}-config`;

      try {
        // Try to update existing ConfigMap.
        await coreApi.replaceNamespacedConfigMap({
          name: configMapName,
          namespace,
          body: {
            metadata: { name: configMapName, namespace },
            data: { "openclaw.json": configJson },
          },
        });
      } catch {
        // Create if not found.
        await coreApi.createNamespacedConfigMap({
          namespace,
          body: {
            metadata: { name: configMapName, namespace },
            data: { "openclaw.json": configJson },
          },
        });
      }
    },

    async deleteGatewayVolume(tenantSlug: string): Promise<void> {
      try {
        await coreApi.deleteNamespacedPersistentVolumeClaim({
          name: pvcName(tenantSlug),
          namespace,
        });
      } catch {
        // PVC may already be deleted.
      }
    },
  };

  return runtime;
}
