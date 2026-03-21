/**
 * Credential sync — pushes tenant BYOK credentials to gateway auth-profiles.json.
 *
 * When a tenant creates, rotates, or deletes a BYOK credential, this module
 * builds a new auth-profiles.json and writes it to the tenant's gateway container.
 * The gateway is then restarted to pick up the changes.
 *
 * For hybrid mode, tenant keys get higher priority via the `order` field,
 * with platform keys as fallback.
 */

import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ContainerRuntime } from "../control-plane/container-runtime.js";
import { getTenant, writeAuditLog } from "../tenants/tenant-store.js";
import type { TenantCredentialMode, TenantId } from "../tenants/types.js";
import { decryptAllTenantCredentials } from "./credential-store.js";
import type { DecryptedCredential } from "./types.js";

const AUTH_PROFILES_PATH = "/home/node/.openclaw/agents/main/agent/auth-profiles.json";

export type CredentialSyncConfig = {
  /** Container runtime for writing files and restarting gateways. */
  runtime: ContainerRuntime;
  /** Platform AI keys to inject for platform/hybrid credential modes. */
  platformAiKeys?: {
    openaiKey?: string;
    anthropicKey?: string;
  };
};

/**
 * Create a credential sync manager.
 *
 * The sync manager coordinates between the credential store (encrypted DB)
 * and running gateway containers (auth-profiles.json on disk).
 */
export function createCredentialSync(config: CredentialSyncConfig) {
  const { runtime, platformAiKeys } = config;

  /**
   * Sync all active credentials for a tenant to their gateway's auth-profiles.json.
   *
   * Flow:
   * 1. Fetch tenant to get credentialMode and gatewayContainerId
   * 2. Decrypt all active credentials from the store
   * 3. Build the AuthProfileStore based on credential mode
   * 4. Write auth-profiles.json to the gateway container
   * 5. Restart the gateway to reload credentials
   * 6. Audit log the sync
   */
  async function syncCredentialsToGateway(tenantId: TenantId): Promise<void> {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found.`);
    }

    if (!tenant.gatewayContainerId) {
      throw new Error(`Tenant ${tenantId} has no gateway container. Cannot sync credentials.`);
    }

    // Decrypt all active credentials for this tenant.
    const decryptedCredentials = await decryptAllTenantCredentials(tenantId);

    // Build the auth-profiles.json content.
    const store = buildAuthProfileStore({
      credentialMode: tenant.credentialMode,
      tenantCredentials: decryptedCredentials,
      platformAiKeys,
    });

    // Write to the gateway container.
    const storeJson = JSON.stringify(store, null, 2);
    await runtime.writeGatewayFile(tenant.gatewayContainerId, AUTH_PROFILES_PATH, storeJson);

    // Restart gateway to pick up changes.
    await runtime.restartGateway(tenant.gatewayContainerId);

    await writeAuditLog({
      tenantId,
      actor: "system",
      action: "credential.sync",
      resourceType: "tenant",
      resourceId: tenantId,
      details: {
        credentialMode: tenant.credentialMode,
        credentialCount: decryptedCredentials.length,
        providers: [...new Set(decryptedCredentials.map((c) => c.credential.provider))],
      },
    });
  }

  return { syncCredentialsToGateway };
}

export type CredentialSync = ReturnType<typeof createCredentialSync>;

// ── Pure Functions (testable without mocks) ─────────────────────

/**
 * Build an AuthProfileStore from tenant credentials and platform keys.
 *
 * Output format matches `AuthProfileStore` from `src/agents/auth-profiles/types.ts`:
 * `{ version: 1, profiles: {...}, order: {...} }`
 *
 * Profile ID conventions:
 * - Tenant BYOK keys: `byok-{provider}-{sanitizedLabel}` or `byok-{provider}-{index}`
 * - Platform keys: `platform-openai`, `platform-anthropic`
 */
export function buildAuthProfileStore(params: {
  credentialMode: TenantCredentialMode;
  tenantCredentials: DecryptedCredential[];
  platformAiKeys?: {
    openaiKey?: string;
    anthropicKey?: string;
  };
}): AuthProfileStore {
  const { credentialMode, tenantCredentials, platformAiKeys } = params;

  const profiles: Record<string, AuthProfileCredential> = {};
  const order: Record<string, string[]> = {};

  // Group tenant credentials by provider for ordering.
  const credsByProvider = new Map<
    string,
    { profileId: string; credential: DecryptedCredential }[]
  >();

  // Add tenant BYOK credentials (for byok and hybrid modes).
  if (credentialMode === "byok" || credentialMode === "hybrid") {
    for (const decrypted of tenantCredentials) {
      const { credential, plaintext } = decrypted;
      const profileId = buildProfileId(credential.provider, credential.label, credential.id);

      profiles[profileId] = {
        type: "api_key",
        provider: credential.provider,
        key: plaintext,
      };

      // Track per-provider groupings for ordering.
      const providerGroup = credsByProvider.get(credential.provider) ?? [];
      providerGroup.push({ profileId, credential: decrypted });
      credsByProvider.set(credential.provider, providerGroup);
    }
  }

  // Add platform keys (for platform and hybrid modes).
  if (credentialMode === "platform" || credentialMode === "hybrid") {
    if (platformAiKeys?.openaiKey) {
      profiles["platform-openai"] = {
        type: "api_key",
        provider: "openai",
        key: platformAiKeys.openaiKey,
      };
    }
    if (platformAiKeys?.anthropicKey) {
      profiles["platform-anthropic"] = {
        type: "api_key",
        provider: "anthropic",
        key: platformAiKeys.anthropicKey,
      };
    }
  }

  // Build per-provider ordering for hybrid mode.
  // Tenant keys come first, platform keys are fallback.
  if (credentialMode === "hybrid") {
    for (const [provider, creds] of credsByProvider) {
      const providerOrder = creds.map((c) => c.profileId);

      // Add platform key as fallback if it exists for this provider.
      const platformProfileId = `platform-${provider}`;
      if (profiles[platformProfileId]) {
        providerOrder.push(platformProfileId);
      }

      order[provider] = providerOrder;
    }

    // Providers with only platform keys (no tenant BYOK) still need ordering.
    if (platformAiKeys?.openaiKey && !credsByProvider.has("openai")) {
      order["openai"] = ["platform-openai"];
    }
    if (platformAiKeys?.anthropicKey && !credsByProvider.has("anthropic")) {
      order["anthropic"] = ["platform-anthropic"];
    }
  }

  return {
    version: 1,
    profiles,
    ...(Object.keys(order).length > 0 ? { order } : {}),
  };
}

/**
 * Build a unique profile ID from provider, label, and credential ID.
 * Always appends a credential ID suffix to prevent collisions when
 * multiple credentials share the same provider + label.
 */
function buildProfileId(provider: string, label: string | undefined, credentialId: string): string {
  const idSuffix = credentialId.slice(0, 8);
  if (label) {
    const sanitized = label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    return `byok-${provider}-${sanitized}-${idSuffix}`;
  }
  return `byok-${provider}-${idSuffix}`;
}
