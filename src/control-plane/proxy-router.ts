/**
 * Tenant proxy routing table.
 *
 * Maintains a mapping from tenant slugs to their gateway container addresses.
 * Used by the control plane's reverse proxy layer (or to generate external
 * proxy configs for nginx/Traefik/Caddy).
 *
 * In Kubernetes, routing is handled by Ingress resources created by the
 * orchestrator. This module provides an in-memory routing table for:
 * - Direct proxy mode (control plane acts as reverse proxy)
 * - Generating external proxy configurations
 * - Resolving tenant gateway addresses for internal API calls
 */

import { listTenants, getTenantBySlug } from "../tenants/tenant-store.js";
import type { Tenant } from "../tenants/types.js";

/** A route entry mapping a tenant slug to its gateway address. */
export type TenantRoute = {
  tenantId: string;
  slug: string;
  /** Full gateway URL (e.g., "http://openclaw-gw-acme.openclaw.svc.cluster.local:18789"). */
  gatewayUrl: string;
  /** Gateway host. */
  host: string;
  /** Gateway port. */
  port: number;
  /** Whether the gateway is currently reachable. */
  healthy: boolean;
};

export type ProxyRouter = {
  /** Resolve a tenant slug to its gateway route. Returns null if not found or unhealthy. */
  resolve(slug: string): Promise<TenantRoute | null>;
  /** Refresh the routing table from the database. */
  refresh(): Promise<void>;
  /** Get all current routes (for generating external proxy config). */
  getAllRoutes(): TenantRoute[];
  /** Mark a route as healthy or unhealthy. */
  setHealth(slug: string, healthy: boolean): void;
  /**
   * Generate an nginx upstream config snippet for all active tenants.
   * Useful for external reverse proxy integration.
   */
  generateNginxConfig(platformDomain: string): string;
};

/**
 * Create a proxy router.
 *
 * Loads active tenant routes from the database and maintains an in-memory
 * routing table. Call `refresh()` periodically or after tenant changes.
 */
export function createProxyRouter(): ProxyRouter {
  const routes = new Map<string, TenantRoute>();

  /** Build a TenantRoute from a Tenant record. */
  function tenantToRoute(tenant: Tenant): TenantRoute | null {
    if (!tenant.gatewayHost || !tenant.gatewayPort) {
      return null;
    }

    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      gatewayUrl: `http://${tenant.gatewayHost}:${tenant.gatewayPort}`,
      host: tenant.gatewayHost,
      port: tenant.gatewayPort,
      healthy: true, // Assume healthy until health monitor says otherwise.
    };
  }

  const router: ProxyRouter = {
    async resolve(slug: string): Promise<TenantRoute | null> {
      const normalizedSlug = slug.toLowerCase().trim();

      // Check cache first.
      const cached = routes.get(normalizedSlug);
      if (cached) {
        return cached.healthy ? cached : null;
      }

      // Cache miss — look up in database.
      const tenant = await getTenantBySlug(normalizedSlug);
      if (!tenant || tenant.status !== "active") {
        return null;
      }

      const route = tenantToRoute(tenant);
      if (route) {
        routes.set(normalizedSlug, route);
      }
      return route;
    },

    async refresh(): Promise<void> {
      routes.clear();

      // Load all active tenants with gateway info.
      let offset = 0;
      const limit = 200;

      while (true) {
        const result = await listTenants({ status: "active", limit, offset });

        for (const tenant of result.tenants) {
          const route = tenantToRoute(tenant);
          if (route) {
            routes.set(tenant.slug, route);
          }
        }

        if (result.tenants.length < limit) {
          break;
        }
        offset += limit;
      }
    },

    getAllRoutes(): TenantRoute[] {
      return Array.from(routes.values());
    },

    setHealth(slug: string, healthy: boolean): void {
      const route = routes.get(slug);
      if (route) {
        route.healthy = healthy;
      }
    },

    generateNginxConfig(platformDomain: string): string {
      const allRoutes = Array.from(routes.values()).filter((r) => r.healthy);

      if (allRoutes.length === 0) {
        return "# No active tenant routes.\n";
      }

      const lines: string[] = [
        "# Auto-generated tenant routing config",
        `# Generated at: ${new Date().toISOString()}`,
        `# Active tenants: ${allRoutes.length}`,
        "",
      ];

      for (const route of allRoutes) {
        lines.push(
          `# Tenant: ${route.slug} (${route.tenantId})`,
          `upstream openclaw_gw_${route.slug.replace(/-/g, "_")} {`,
          `    server ${route.host}:${route.port};`,
          `}`,
          "",
          `server {`,
          `    listen 443 ssl;`,
          `    server_name ${route.slug}.${platformDomain};`,
          "",
          `    location / {`,
          `        proxy_pass http://openclaw_gw_${route.slug.replace(/-/g, "_")};`,
          `        proxy_http_version 1.1;`,
          `        proxy_set_header Upgrade $http_upgrade;`,
          `        proxy_set_header Connection "upgrade";`,
          `        proxy_set_header Host $host;`,
          `        proxy_set_header X-Real-IP $remote_addr;`,
          `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
          `        proxy_set_header X-Forwarded-Proto $scheme;`,
          `        proxy_read_timeout 3600s;`,
          `        proxy_send_timeout 3600s;`,
          `    }`,
          `}`,
          "",
        );
      }

      return lines.join("\n");
    },
  };

  return router;
}
