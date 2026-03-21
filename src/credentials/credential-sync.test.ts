import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedCredential } from "./types.js";

// ── Mocks for syncCredentialsToGateway integration tests ────────

const mockGetTenant = vi.fn();
const mockDecryptAll = vi.fn();
const mockWriteAuditLog = vi.fn();

vi.mock("../tenants/tenant-store.js", () => ({
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

vi.mock("./credential-store.js", () => ({
  decryptAllTenantCredentials: (...args: unknown[]) => mockDecryptAll(...args),
}));

const { buildAuthProfileStore, createCredentialSync } = await import("./credential-sync.js");

// ── Test Data ───────────────────────────────────────────────────

function makeDecryptedCredential(
  overrides: Partial<DecryptedCredential["credential"]> & { plaintext?: string } = {},
): DecryptedCredential {
  const { plaintext = "sk-test-key-123", ...credOverrides } = overrides;
  return {
    credential: {
      id: "cred-0001",
      tenantId: "tenant-001",
      provider: "openai",
      label: "Production Key",
      keyPrefix: "sk-test-",
      createdAt: "2026-03-20T12:00:00Z",
      ...credOverrides,
    },
    plaintext,
  };
}

const PLATFORM_KEYS = {
  openaiKey: "sk-platform-openai-key",
  anthropicKey: "sk-platform-anthropic-key",
};

function makeMockRuntime() {
  return {
    runtimeId: "docker" as const,
    createGateway: vi.fn(),
    stopGateway: vi.fn(),
    startGateway: vi.fn(),
    removeGateway: vi.fn(),
    getGatewayStatus: vi.fn(),
    getGatewayLogs: vi.fn(),
    restartGateway: vi.fn(),
    writeGatewayConfig: vi.fn(),
    writeGatewayFile: vi.fn(),
    readGatewayFile: vi.fn(),
    deleteGatewayVolume: vi.fn(),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("buildAuthProfileStore", () => {
  describe("BYOK mode", () => {
    it("includes only tenant keys, no platform keys", () => {
      const store = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [
          makeDecryptedCredential({ provider: "openai", label: "My OpenAI" }),
          makeDecryptedCredential({
            id: "bbbb0002",
            provider: "anthropic",
            label: "My Anthropic",
            plaintext: "sk-ant-123",
          }),
        ],
        platformAiKeys: PLATFORM_KEYS,
      });

      expect(Object.keys(store.profiles)).toHaveLength(2);
      // Profile IDs include credential ID suffix for uniqueness.
      expect(store.profiles["byok-openai-my-openai-cred-000"]).toBeDefined();
      expect(store.profiles["byok-anthropic-my-anthropic-bbbb0002"]).toBeDefined();
      expect(store.profiles["platform-openai"]).toBeUndefined();
      expect(store.profiles["platform-anthropic"]).toBeUndefined();
      expect(store.profiles["byok-openai-my-openai-cred-000"].type).toBe("api_key");
    });

    it("uses credential ID suffix when label is missing", () => {
      const store = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [makeDecryptedCredential({ label: undefined, id: "abc12345-6789" })],
      });

      expect(store.profiles["byok-openai-abc12345"]).toBeDefined();
    });

    it("handles duplicate provider + label with unique IDs", () => {
      const store = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [
          makeDecryptedCredential({ id: "cred-aaa1", provider: "openai", label: "Same Label" }),
          makeDecryptedCredential({
            id: "cred-bbb2",
            provider: "openai",
            label: "Same Label",
            plaintext: "sk-other",
          }),
        ],
      });

      // Both should exist with distinct profile IDs (credential ID suffix prevents collision).
      expect(Object.keys(store.profiles)).toHaveLength(2);
      expect(store.profiles["byok-openai-same-label-cred-aaa"]).toBeDefined();
      expect(store.profiles["byok-openai-same-label-cred-bbb"]).toBeDefined();
    });

    it("handles empty credential list", () => {
      const store = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [],
      });

      expect(Object.keys(store.profiles)).toHaveLength(0);
    });
  });

  describe("Platform mode", () => {
    it("includes only platform keys, ignores tenant credentials", () => {
      const store = buildAuthProfileStore({
        credentialMode: "platform",
        tenantCredentials: [makeDecryptedCredential()],
        platformAiKeys: PLATFORM_KEYS,
      });

      expect(Object.keys(store.profiles)).toHaveLength(2);
      expect(store.profiles["platform-openai"]).toBeDefined();
      expect(store.profiles["platform-anthropic"]).toBeDefined();
      expect(store.profiles["platform-openai"].type).toBe("api_key");
      expect((store.profiles["platform-openai"] as { key: string }).key).toBe(
        PLATFORM_KEYS.openaiKey,
      );
    });

    it("handles missing platform keys gracefully", () => {
      const store = buildAuthProfileStore({
        credentialMode: "platform",
        tenantCredentials: [],
        platformAiKeys: { openaiKey: "sk-only-openai" },
      });

      expect(Object.keys(store.profiles)).toHaveLength(1);
      expect(store.profiles["platform-openai"]).toBeDefined();
      expect(store.profiles["platform-anthropic"]).toBeUndefined();
    });
  });

  describe("Hybrid mode", () => {
    it("includes both tenant and platform keys", () => {
      const store = buildAuthProfileStore({
        credentialMode: "hybrid",
        tenantCredentials: [makeDecryptedCredential({ provider: "openai", label: "My Key" })],
        platformAiKeys: PLATFORM_KEYS,
      });

      expect(Object.keys(store.profiles)).toHaveLength(3); // 1 tenant + 2 platform
      expect(store.profiles["byok-openai-my-key-cred-000"]).toBeDefined();
      expect(store.profiles["platform-openai"]).toBeDefined();
      expect(store.profiles["platform-anthropic"]).toBeDefined();
    });

    it("sets order with tenant keys first, platform as fallback", () => {
      const store = buildAuthProfileStore({
        credentialMode: "hybrid",
        tenantCredentials: [
          makeDecryptedCredential({ id: "aaaaaaaa-1111", provider: "openai", label: "Key 1" }),
          makeDecryptedCredential({
            id: "bbbbbbbb-2222",
            provider: "openai",
            label: "Key 2",
            plaintext: "sk-key2",
          }),
        ],
        platformAiKeys: PLATFORM_KEYS,
      });

      expect(store.order).toBeDefined();
      expect(store.order!["openai"]).toEqual([
        "byok-openai-key-1-aaaaaaaa",
        "byok-openai-key-2-bbbbbbbb",
        "platform-openai",
      ]);
    });

    it("includes platform-only providers in order", () => {
      const store = buildAuthProfileStore({
        credentialMode: "hybrid",
        tenantCredentials: [makeDecryptedCredential({ provider: "openai", label: "My Key" })],
        platformAiKeys: PLATFORM_KEYS,
      });

      // Anthropic has no tenant keys, but platform key should be in order.
      expect(store.order!["anthropic"]).toEqual(["platform-anthropic"]);
    });

    it("handles no tenant credentials (platform-only fallback)", () => {
      const store = buildAuthProfileStore({
        credentialMode: "hybrid",
        tenantCredentials: [],
        platformAiKeys: PLATFORM_KEYS,
      });

      expect(Object.keys(store.profiles)).toHaveLength(2);
      expect(store.order!["openai"]).toEqual(["platform-openai"]);
      expect(store.order!["anthropic"]).toEqual(["platform-anthropic"]);
    });
  });

  describe("store format", () => {
    it("always includes version: 1", () => {
      const store = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [],
      });
      expect(store.version).toBe(1);
    });

    it("omits order field when not needed (byok/platform modes)", () => {
      const byokStore = buildAuthProfileStore({
        credentialMode: "byok",
        tenantCredentials: [makeDecryptedCredential()],
      });
      expect(byokStore.order).toBeUndefined();

      const platformStore = buildAuthProfileStore({
        credentialMode: "platform",
        tenantCredentials: [],
        platformAiKeys: PLATFORM_KEYS,
      });
      expect(platformStore.order).toBeUndefined();
    });
  });
});

// ── syncCredentialsToGateway integration tests ──────────────────

describe("syncCredentialsToGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decrypts credentials, writes auth-profiles.json, restarts gateway, and audit logs", async () => {
    const runtime = makeMockRuntime();
    const sync = createCredentialSync({ runtime, platformAiKeys: PLATFORM_KEYS });

    mockGetTenant.mockResolvedValueOnce({
      id: "tenant-001",
      slug: "acme",
      credentialMode: "hybrid",
      gatewayContainerId: "openclaw-gw-acme",
    });

    mockDecryptAll.mockResolvedValueOnce([
      makeDecryptedCredential({ provider: "openai", label: "My Key" }),
    ]);

    mockWriteAuditLog.mockResolvedValue(undefined);

    await sync.syncCredentialsToGateway("tenant-001");

    // Verify auth-profiles.json was written to the gateway container.
    expect(runtime.writeGatewayFile).toHaveBeenCalledOnce();
    const [containerId, filePath, content] = runtime.writeGatewayFile.mock.calls[0];
    expect(containerId).toBe("openclaw-gw-acme");
    expect(filePath).toContain("auth-profiles.json");

    // Verify written JSON is a valid AuthProfileStore with tenant + platform keys.
    const store = JSON.parse(content);
    expect(store.version).toBe(1);
    expect(store.profiles["platform-openai"]).toBeDefined();
    expect(store.profiles["platform-anthropic"]).toBeDefined();
    // Tenant key profile (hybrid mode includes BYOK keys).
    const byokKeys = Object.keys(store.profiles).filter((k) => k.startsWith("byok-"));
    expect(byokKeys).toHaveLength(1);
    // Hybrid mode includes order field.
    expect(store.order).toBeDefined();

    // Verify gateway was restarted.
    expect(runtime.restartGateway).toHaveBeenCalledWith("openclaw-gw-acme");

    // Verify audit log was written.
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-001",
        action: "credential.sync",
        details: expect.objectContaining({ credentialMode: "hybrid", credentialCount: 1 }),
      }),
    );
  });

  it("throws when tenant not found", async () => {
    const runtime = makeMockRuntime();
    const sync = createCredentialSync({ runtime });

    mockGetTenant.mockResolvedValueOnce(null);

    await expect(sync.syncCredentialsToGateway("nonexistent")).rejects.toThrow(
      "Tenant nonexistent not found",
    );
    expect(runtime.writeGatewayFile).not.toHaveBeenCalled();
  });

  it("throws when tenant has no gateway container", async () => {
    const runtime = makeMockRuntime();
    const sync = createCredentialSync({ runtime });

    mockGetTenant.mockResolvedValueOnce({
      id: "tenant-001",
      slug: "acme",
      credentialMode: "byok",
      gatewayContainerId: undefined,
    });

    await expect(sync.syncCredentialsToGateway("tenant-001")).rejects.toThrow(
      "no gateway container",
    );
    expect(runtime.writeGatewayFile).not.toHaveBeenCalled();
  });

  it("writes platform-only store for platform credential mode", async () => {
    const runtime = makeMockRuntime();
    const sync = createCredentialSync({ runtime, platformAiKeys: PLATFORM_KEYS });

    mockGetTenant.mockResolvedValueOnce({
      id: "tenant-002",
      slug: "beta",
      credentialMode: "platform",
      gatewayContainerId: "openclaw-gw-beta",
    });

    mockDecryptAll.mockResolvedValueOnce([]);
    mockWriteAuditLog.mockResolvedValue(undefined);

    await sync.syncCredentialsToGateway("tenant-002");

    const store = JSON.parse(runtime.writeGatewayFile.mock.calls[0][2]);
    // Platform mode: only platform keys, no BYOK.
    expect(Object.keys(store.profiles)).toHaveLength(2);
    expect(store.profiles["platform-openai"]).toBeDefined();
    expect(store.profiles["platform-anthropic"]).toBeDefined();
    expect(store.order).toBeUndefined();
  });
});
