/**
 * CLI commands for the multi-tenant control plane.
 *
 * Provides subcommands for:
 * - `control-plane run` — Start the API server + background services
 * - `control-plane migrate` — Run database migrations
 * - `control-plane tenant create|list|get|suspend|resume|delete` — Tenant management
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("control-plane/cli");

/**
 * Register the `control-plane` CLI subcommand group.
 */
export function registerControlPlaneCli(program: Command): void {
  const cp = program.command("control-plane").description("Multi-tenant control plane management");

  // ── control-plane run ──────────────────────────────────────

  cp.command("run")
    .description("Start the control plane API server and background services")
    .option("--port <port>", "API server port", "3100")
    .option("--host <host>", "API server bind address", "0.0.0.0")
    .option("--runtime <type>", "Container runtime: docker or kubernetes", "docker")
    .option("--gateway-image <image>", "Gateway container image", "openclaw:latest")
    .action(async (opts) => {
      const port = Number.parseInt(opts.port as string, 10);
      const host = opts.host as string;
      const runtimeType = opts.runtime as "docker" | "kubernetes";
      const gatewayImage = opts.gatewayImage as string;

      log.info(`Starting control plane (runtime=${runtimeType}, port=${port})...`);

      // Lazy-load heavy modules only when actually running.
      const { createOrchestrator } = await import("../orchestrator.js");
      const { createCredentialSync } = await import("../../credentials/credential-sync.js");
      const { createUsageCollector } = await import("../../usage-collector/usage-collector.js");
      const { startHealthMonitor } = await import("../health-monitor.js");
      const { createControlPlaneServer } = await import("../api/server.js");

      // Create container runtime.
      let runtime;
      if (runtimeType === "kubernetes") {
        const { createKubernetesRuntime } = await import("../runtimes/kubernetes.js");
        runtime = createKubernetesRuntime({ defaultImage: gatewayImage });
      } else {
        const { createDockerRuntime } = await import("../runtimes/docker.js");
        runtime = createDockerRuntime({ defaultImage: gatewayImage });
      }

      // Read platform AI keys from environment.
      const platformAiKeys = {
        openaiKey: process.env.OPENCLAW_PLATFORM_OPENAI_KEY,
        anthropicKey: process.env.OPENCLAW_PLATFORM_ANTHROPIC_KEY,
      };

      // Create core services.
      const orchestrator = createOrchestrator({
        runtime,
        gatewayImage,
        platformAiKeys,
      });

      const credentialSync = createCredentialSync({ runtime, platformAiKeys });

      // Create graceful shutdown controller.
      const abortController = new AbortController();
      const { signal } = abortController;

      // Start background services.
      const healthMonitor = startHealthMonitor({
        runtime,
        abortSignal: signal,
      });

      const usageCollector = createUsageCollector({
        runtime,
        abortSignal: signal,
      });
      usageCollector.startCollector();

      // Build webhook config from environment.
      const webhookConfig = buildWebhookConfig();

      // Start API server.
      const server = createControlPlaneServer({
        orchestrator,
        credentialSync,
        webhookConfig,
        port,
        host,
      });

      await server.start();

      log.info("Control plane is running. Press Ctrl+C to stop.");

      // Graceful shutdown handler.
      const shutdown = async () => {
        log.info("Shutting down...");
        abortController.abort();
        healthMonitor.stop();
        usageCollector.stopCollector();
        await server.stop();
        log.info("Control plane stopped.");
        process.exit(0);
      };

      process.on("SIGTERM", () => void shutdown());
      process.on("SIGINT", () => void shutdown());
    });

  // ── control-plane migrate ──────────────────────────────────

  cp.command("migrate")
    .description("Run control plane database migrations")
    .action(async () => {
      const { getDb } = await import("../db.js");
      const db = getDb();

      // Read and execute migration files in order.
      const migrationsDir = path.resolve(
        import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
        "../migrations",
      );

      if (!fs.existsSync(migrationsDir)) {
        log.error(`Migrations directory not found: ${migrationsDir}`);
        process.exit(1);
      }

      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .toSorted();

      if (files.length === 0) {
        log.info("No migration files found.");
        return;
      }

      // Create migrations tracking table if needed.
      await db.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      for (const file of files) {
        // Check if already applied.
        const applied = await db.query("SELECT 1 FROM _migrations WHERE name = $1", [file]);

        if (applied.rows.length > 0) {
          log.debug(`Skipping already applied migration: ${file}`);
          continue;
        }

        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, "utf-8");

        log.info(`Applying migration: ${file}`);
        await db.query(sql);

        // Mark as applied.
        await db.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      }

      log.info("All migrations applied.");
    });

  // ── control-plane tenant ───────────────────────────────────

  const tenant = cp.command("tenant").description("Manage tenants");

  // tenant create
  tenant
    .command("create")
    .description("Create and provision a new tenant")
    .requiredOption("--slug <slug>", "URL-safe tenant slug")
    .requiredOption("--email <email>", "Contact email")
    .option("--plan <plan>", "Billing plan (free, starter, pro, enterprise)", "starter")
    .option("--credential-mode <mode>", "Credential mode (platform, byok, hybrid)", "platform")
    .option("--display-name <name>", "Human-readable display name")
    .option("--json", "Output JSON format", false)
    .action(async (opts) => {
      const { createOrchestrator } = await import("../orchestrator.js");
      const { createDockerRuntime } = await import("../runtimes/docker.js");

      // Use Docker runtime for CLI (K8s would need kubeconfig setup).
      const runtime = createDockerRuntime({ defaultImage: "openclaw:latest" });
      const orchestrator = createOrchestrator({ runtime });

      try {
        const result = await orchestrator.provisionTenant(
          {
            slug: opts.slug as string,
            displayName: (opts.displayName as string) || (opts.slug as string),
            plan: opts.plan as "free" | "starter" | "pro" | "enterprise",
            credentialMode: opts.credentialMode as "platform" | "byok" | "hybrid",
            contactEmail: opts.email as string,
          },
          "cli",
        );

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\nTenant provisioned successfully!`);
          console.log(`  ID:     ${result.tenant.id}`);
          console.log(`  Slug:   ${result.tenant.slug}`);
          console.log(`  Plan:   ${result.tenant.plan}`);
          console.log(`  Status: ${result.tenant.status}`);
          console.log(`\n  API Key: ${result.controlPlaneApiKey}`);
          console.log(`  (Save this key — it will not be shown again)\n`);
        }
      } catch (err) {
        console.error(
          `Failed to provision tenant: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  // tenant list
  tenant
    .command("list")
    .description("List all tenants")
    .option("--status <status>", "Filter by status")
    .option("--plan <plan>", "Filter by plan")
    .option("--search <query>", "Search by slug or name")
    .option("--limit <n>", "Results per page", "50")
    .option("--json", "Output JSON format", false)
    .action(async (opts) => {
      const { listTenants } = await import("../../tenants/tenant-store.js");

      const result = await listTenants({
        status: opts.status as undefined,
        plan: opts.plan as undefined,
        search: opts.search as string | undefined,
        limit: Number.parseInt(opts.limit as string, 10),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nTenants (${result.total} total):\n`);

        if (result.tenants.length === 0) {
          console.log("  No tenants found.\n");
          return;
        }

        for (const t of result.tenants) {
          const statusIndicator =
            t.status === "active" ? "●" : t.status === "suspended" ? "○" : "◌";
          console.log(
            `  ${statusIndicator} ${t.slug.padEnd(24)} ${t.plan.padEnd(12)} ${t.status.padEnd(14)} ${t.credentialMode}`,
          );
        }
        console.log();
      }
    });

  // tenant get
  tenant
    .command("get <id>")
    .description("Show tenant details")
    .option("--json", "Output JSON format", false)
    .action(async (id: string, opts) => {
      const { getTenant } = await import("../../tenants/tenant-store.js");

      const t = await getTenant(id);
      if (!t) {
        console.error(`Tenant ${id} not found.`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(t, null, 2));
      } else {
        console.log(`\nTenant Details:`);
        console.log(`  ID:              ${t.id}`);
        console.log(`  Slug:            ${t.slug}`);
        console.log(`  Display Name:    ${t.displayName}`);
        console.log(`  Status:          ${t.status}`);
        console.log(`  Plan:            ${t.plan}`);
        console.log(`  Credential Mode: ${t.credentialMode}`);
        console.log(`  Email:           ${t.contactEmail}`);
        console.log(`  Gateway:         ${t.gatewayContainerId || "(none)"}`);
        console.log(`  Activity:        ${t.activityState}`);
        console.log(`  Created:         ${t.createdAt}`);
        if (t.suspendedAt) {
          console.log(`  Suspended:       ${t.suspendedAt}`);
          console.log(`  Reason:          ${t.suspendedReason || "(none)"}`);
        }
        console.log();
      }
    });

  // tenant suspend
  tenant
    .command("suspend <id>")
    .description("Suspend a tenant")
    .option("--reason <reason>", "Suspension reason", "Manually suspended via CLI")
    .action(async (id: string, opts) => {
      const { suspendTenant } = await import("../../tenants/tenant-store.js");

      const result = await suspendTenant(id, opts.reason as string);
      if (!result) {
        console.error(`Tenant ${id} not found or already deleted.`);
        process.exit(1);
      }

      console.log(`Tenant ${result.slug} suspended.`);
    });

  // tenant resume
  tenant
    .command("resume <id>")
    .description("Resume a suspended tenant")
    .action(async (id: string) => {
      const { resumeTenant } = await import("../../tenants/tenant-store.js");

      const result = await resumeTenant(id);
      if (!result) {
        console.error(`Tenant ${id} not found or not suspended.`);
        process.exit(1);
      }

      console.log(`Tenant ${result.slug} resumed.`);
    });

  // tenant delete
  tenant
    .command("delete <id>")
    .description("Deprovision and delete a tenant")
    .option("--confirm", "Confirm deletion (required)", false)
    .action(async (id: string, opts) => {
      if (!opts.confirm) {
        console.error("Add --confirm to confirm deletion. This action is irreversible.");
        process.exit(1);
      }

      const { createOrchestrator } = await import("../orchestrator.js");
      const { createDockerRuntime } = await import("../runtimes/docker.js");

      const runtime = createDockerRuntime({ defaultImage: "openclaw:latest" });
      const orchestrator = createOrchestrator({ runtime });

      try {
        await orchestrator.deprovisionTenant(id, "cli");
        console.log(`Tenant ${id} deprovisioned and deleted.`);
      } catch (err) {
        console.error(
          `Failed to delete tenant: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}

// ── Helpers ────────────────────────────────────────────────────

/** Build webhook configuration from environment variables. */
function buildWebhookConfig() {
  const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const paddleSecret = process.env.PADDLE_WEBHOOK_SECRET;
  const lemonSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  const webhookSecrets: Record<string, string> = {};
  if (stripeSecret) {
    webhookSecrets.stripe = stripeSecret;
  }
  if (paddleSecret) {
    webhookSecrets.paddle = paddleSecret;
  }
  if (lemonSecret) {
    webhookSecrets.lemonsqueezy = lemonSecret;
  }

  if (Object.keys(webhookSecrets).length === 0) {
    return undefined;
  }

  return {
    webhookSecrets,
    maxPaymentFailures: Number.parseInt(process.env.MAX_PAYMENT_FAILURES || "3", 10),
  };
}
