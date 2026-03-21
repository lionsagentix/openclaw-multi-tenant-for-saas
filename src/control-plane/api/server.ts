/**
 * Control plane API server.
 *
 * Creates and configures the Express application with all route groups,
 * middleware, and lifecycle management. The server exposes:
 *
 * - Admin routes at /api/v1/tenants (admin-scoped API key)
 * - Tenant self-service routes at /api/v1/tenant (tenant-scoped API key)
 * - Webhook routes at /api/v1/webhooks/billing/:provider (signature-verified)
 * - Health probe at /health (no auth)
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import express from "express";
import type { BillingProviderName } from "../../billing/types.js";
import { createWebhookHandler, type WebhookHandlerConfig } from "../../billing/webhook-handler.js";
import type { CredentialSync } from "../../credentials/credential-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Orchestrator } from "../orchestrator.js";
import { createAdminRoutes } from "./admin-routes.js";
import { errorHandler, requireAdmin, requireTenant } from "./middleware.js";
import { createTenantRoutes } from "./tenant-routes.js";

const log = createSubsystemLogger("control-plane/api/server");

export type ControlPlaneServerConfig = {
  /** Gateway orchestrator for lifecycle operations. */
  orchestrator: Orchestrator;
  /** Credential sync manager for BYOK operations. */
  credentialSync: CredentialSync;
  /** Webhook configuration for billing providers. */
  webhookConfig?: WebhookHandlerConfig;
  /** Server listen port. Default: 3100. */
  port?: number;
  /** Server listen host. Default: "0.0.0.0". */
  host?: string;
};

export type ControlPlaneServer = {
  /** The Express application (for testing or custom middleware). */
  app: express.Application;
  /** Start listening. Returns the HTTP server instance. */
  start(): Promise<Server>;
  /** Gracefully stop the server. */
  stop(): Promise<void>;
};

/**
 * Create the control plane API server.
 *
 * Does not start listening — call `server.start()` to begin accepting connections.
 */
export function createControlPlaneServer(config: ControlPlaneServerConfig): ControlPlaneServer {
  const { orchestrator, credentialSync, webhookConfig, port = 3100, host = "0.0.0.0" } = config;

  const app = express();
  let httpServer: Server | null = null;

  // ── Global Middleware ─────────────────────────────────────────

  // JSON body parsing for all routes except webhooks (need raw body).
  app.use("/api/v1/webhooks", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));

  // Request logging.
  app.use((req, _res, next) => {
    log.debug(`${req.method} ${req.path}`);
    next();
  });

  // ── Health Probe ──────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Route Groups ──────────────────────────────────────────────

  // Admin routes: require admin-scoped API key.
  const adminRoutes = createAdminRoutes({ orchestrator });
  app.use("/api/v1/tenants", requireAdmin(), adminRoutes);

  // Tenant self-service routes: require tenant-scoped API key (admin also allowed).
  const tenantRoutes = createTenantRoutes({ orchestrator, credentialSync });
  app.use("/api/v1/tenant", requireTenant(), tenantRoutes);

  // Webhook routes: no API key auth — signature-verified by webhook handler.
  if (webhookConfig) {
    const handleWebhook = createWebhookHandler(webhookConfig);

    app.post("/api/v1/webhooks/billing/:provider", async (req, res) => {
      const providerName = req.params.provider as BillingProviderName;
      // The webhook handler expects raw IncomingMessage + ServerResponse.
      await handleWebhook(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        providerName,
      );
    });
  }

  // ── Error Handler ─────────────────────────────────────────────

  app.use(errorHandler);

  // ── Lifecycle ─────────────────────────────────────────────────

  async function start(): Promise<Server> {
    return new Promise((resolve) => {
      httpServer = app.listen(port, host, () => {
        log.info(`Control plane API server listening on ${host}:${port}`);
        resolve(httpServer!);
      });
    });
  }

  async function stop(): Promise<void> {
    if (!httpServer) {
      return;
    }

    return new Promise((resolve, reject) => {
      httpServer!.close((err) => {
        if (err) {
          reject(err);
        } else {
          log.info("Control plane API server stopped.");
          httpServer = null;
          resolve();
        }
      });
    });
  }

  return { app, start, stop };
}
