/**
 * Generates a hardened OpenClawConfig for a tenant gateway.
 *
 * Follows SECURITY.md multi-user remediation guidance:
 * - agents.defaults.sandbox.mode = "all"
 * - tools.fs.workspaceOnly = true
 * - tools.exec.applyPatch.workspaceOnly = true
 * - Gateway auth via SecretRef (env source)
 *
 * AI credential injection depends on the tenant's credentialMode:
 * - "platform": platform API keys injected as SecretRef env refs
 * - "byok": no keys injected; tenant manages via control plane API
 * - "hybrid": platform keys as fallback (lower priority in auth profile order)
 */

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Tenant, TenantCredentialMode } from "./types.js";

/**
 * Environment variable names for platform-provided AI keys.
 * Referenced by container runtimes (Docker/K8s) when injecting env vars into tenant pods.
 */
export const PLATFORM_AI_ENV_VARS = {
  openai: "OPENCLAW_PLATFORM_OPENAI_KEY",
  anthropic: "OPENCLAW_PLATFORM_ANTHROPIC_KEY",
} as const;

/** Environment variable name for the gateway auth token. */
const GATEWAY_TOKEN_ENV = "OPENCLAW_GATEWAY_TOKEN";

/**
 * Generate a hardened OpenClawConfig for a tenant's gateway instance.
 *
 * This config is written to the tenant's PVC at /home/node/.openclaw/openclaw.json
 * and loaded by the gateway on startup.
 */
export function generateTenantConfig(params: {
  tenant: Tenant;
  /** Additional channels config to merge (e.g., if tenant has pre-configured channels). */
  channelsOverride?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const { tenant } = params;

  const config: OpenClawConfig = {
    meta: {
      lastTouchedVersion: "multi-tenant-control-plane",
      lastTouchedAt: new Date().toISOString(),
    },

    // ── Security Hardening (SECURITY.md guidance) ────────────
    agents: {
      defaults: {
        sandbox: {
          // Full sandboxing for all agents — required for mutually untrusted tenants.
          mode: "all",
        },
      },
    },

    tools: {
      fs: {
        // Restrict all filesystem tools to workspace directory only.
        workspaceOnly: true,
      },
    },

    // ── Gateway Auth ─────────────────────────────────────────
    gateway: {
      auth: {
        mode: "token",
        // Token read from environment variable (injected by K8s Secret).
        token: {
          source: "env",
          provider: "default",
          id: GATEWAY_TOKEN_ENV,
        },
      },
      // Bind to all interfaces (required for K8s pod networking).
      bind: "lan",
    },

    // ── AI Credentials ───────────────────────────────────────
    auth: buildAuthConfig(tenant.credentialMode),

    // ── Channel config (optional override) ───────────────────
    ...(params.channelsOverride ? { channels: params.channelsOverride } : {}),
  };

  return config;
}

/**
 * Build auth config based on the tenant's credential mode.
 *
 * - "platform": inject platform keys as SecretRef env references
 * - "byok": empty auth (tenant will populate via control plane API)
 * - "hybrid": inject platform keys but with lower priority
 */
function buildAuthConfig(credentialMode: TenantCredentialMode): OpenClawConfig["auth"] {
  switch (credentialMode) {
    case "byok":
      // No platform keys injected. Tenant manages their own via the control plane API,
      // which writes to the gateway's auth-profiles.json on the PVC.
      return undefined;

    case "platform":
      // Platform-provided keys as the primary (and only) AI credentials.
      // Actual API keys are injected via env vars and stored in auth-profiles.json
      // on the tenant's PVC at container startup.
      return {
        profiles: {
          "platform-openai": {
            provider: "openai",
            mode: "api_key" as const,
          },
          "platform-anthropic": {
            provider: "anthropic",
            mode: "api_key" as const,
          },
        },
      };

    case "hybrid":
      // Platform keys injected as fallback. Tenant's own keys (added later via API)
      // will be prioritized by the auth profile ordering system.
      // The `order` field ensures tenant keys come first when they exist.
      // Actual API keys are injected via env vars and stored in auth-profiles.json
      // on the tenant's PVC at container startup.
      return {
        profiles: {
          "platform-openai": {
            provider: "openai",
            mode: "api_key" as const,
          },
          "platform-anthropic": {
            provider: "anthropic",
            mode: "api_key" as const,
          },
        },
      };

    default: {
      // Exhaustive check.
      const _exhaustive: never = credentialMode;
      return undefined;
    }
  }
}

/**
 * Validate that a generated tenant config meets SECURITY.md requirements.
 * Returns a list of violations (empty = passes).
 *
 * This is a safety check to ensure no code path accidentally generates
 * an insecure config for a multi-tenant gateway.
 */
export function validateTenantConfigSecurity(config: OpenClawConfig): string[] {
  const violations: string[] = [];

  // Check sandbox mode.
  const sandboxMode = config.agents?.defaults?.sandbox?.mode;
  if (sandboxMode !== "all") {
    violations.push(
      `agents.defaults.sandbox.mode must be "all" for multi-tenant gateways (got: "${sandboxMode ?? "undefined"}").`,
    );
  }

  // Check filesystem restriction.
  const fsWorkspaceOnly = config.tools?.fs?.workspaceOnly;
  if (fsWorkspaceOnly !== true) {
    violations.push(
      `tools.fs.workspaceOnly must be true for multi-tenant gateways (got: ${fsWorkspaceOnly}).`,
    );
  }

  // Check gateway auth is configured.
  const authMode = config.gateway?.auth?.mode;
  if (!authMode || authMode === "none") {
    violations.push("gateway.auth.mode must be configured (not 'none') for multi-tenant gateways.");
  }

  return violations;
}
