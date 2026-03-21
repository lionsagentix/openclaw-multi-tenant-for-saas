import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

// Hoist mocks to top level to avoid vitest warnings.
vi.mock("../tenants/tenant-store.js", () => ({
  listTenants: vi.fn(),
}));

vi.mock("../billing/usage-metering.js", () => ({
  recordUsage: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { extractMeterableUsage } = await import("./usage-collector.js");

// ── extractMeterableUsage tests (pure function) ─────────────────

describe("extractMeterableUsage", () => {
  function makeStore(overrides: Partial<AuthProfileStore> = {}): AuthProfileStore {
    return {
      version: 1,
      profiles: {
        "platform-openai": { type: "api_key", provider: "openai", key: "sk-test" },
        "platform-anthropic": { type: "api_key", provider: "anthropic", key: "sk-ant" },
      },
      ...overrides,
    };
  }

  describe("platform mode", () => {
    it("counts all profile usage", () => {
      const store = makeStore({
        usageStats: {
          "platform-openai": { lastUsed: Date.now(), errorCount: 5 },
          "platform-anthropic": { lastUsed: Date.now(), errorCount: 3 },
        },
      });

      const result = extractMeterableUsage(store, "platform");
      expect(result.totalRequests).toBe(8);
      expect(result.estimatedTokens).toBe(8000);
    });

    it("returns zero when no usageStats", () => {
      const store = makeStore();
      const result = extractMeterableUsage(store, "platform");
      expect(result.totalRequests).toBe(0);
      expect(result.estimatedTokens).toBe(0);
    });

    it("returns zero when usageStats are empty", () => {
      const store = makeStore({ usageStats: {} });
      const result = extractMeterableUsage(store, "platform");
      expect(result.totalRequests).toBe(0);
    });
  });

  describe("hybrid mode", () => {
    it("only counts platform profile usage, skips BYOK profiles", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "byok-openai-my-key": { type: "api_key", provider: "openai", key: "sk-byok" },
          "platform-openai": { type: "api_key", provider: "openai", key: "sk-platform" },
          "platform-anthropic": { type: "api_key", provider: "anthropic", key: "sk-ant" },
        },
        usageStats: {
          "byok-openai-my-key": { lastUsed: Date.now(), errorCount: 100 },
          "platform-openai": { lastUsed: Date.now(), errorCount: 10 },
          "platform-anthropic": { lastUsed: Date.now(), errorCount: 5 },
        },
      };

      const result = extractMeterableUsage(store, "hybrid");
      // Only platform profiles: 10 + 5 = 15 (not 100 from BYOK)
      expect(result.totalRequests).toBe(15);
      expect(result.estimatedTokens).toBe(15000);
    });

    it("returns zero when only BYOK profiles have usage", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "byok-openai-my-key": { type: "api_key", provider: "openai", key: "sk-byok" },
          "platform-openai": { type: "api_key", provider: "openai", key: "sk-platform" },
        },
        usageStats: {
          "byok-openai-my-key": { lastUsed: Date.now(), errorCount: 50 },
          "platform-openai": {}, // No usage on platform key
        },
      };

      const result = extractMeterableUsage(store, "hybrid");
      expect(result.totalRequests).toBe(0);
    });
  });

  describe("BYOK mode", () => {
    it("counts all profile usage (BYOK mode should not normally be called)", () => {
      const store = makeStore({
        usageStats: {
          "platform-openai": { lastUsed: Date.now(), errorCount: 5 },
        },
      });

      // BYOK tenants shouldn't be collected at all, but if they are,
      // the function still works (no filtering by profile ID prefix).
      const result = extractMeterableUsage(store, "byok");
      expect(result.totalRequests).toBe(5);
    });
  });

  describe("primary provider detection", () => {
    it("identifies the provider with most requests", () => {
      const store = makeStore({
        usageStats: {
          "platform-openai": { lastUsed: Date.now(), errorCount: 3 },
          "platform-anthropic": { lastUsed: Date.now(), errorCount: 10 },
        },
      });

      const result = extractMeterableUsage(store, "platform");
      expect(result.primaryProvider).toBe("anthropic");
    });

    it("returns 'unknown' when no usage data", () => {
      const store = makeStore();
      const result = extractMeterableUsage(store, "platform");
      expect(result.primaryProvider).toBe("unknown");
    });
  });

  describe("request counting", () => {
    it("counts profiles with lastUsed but no errorCount as 1 request", () => {
      const store = makeStore({
        usageStats: {
          "platform-openai": { lastUsed: Date.now() },
        },
      });

      const result = extractMeterableUsage(store, "platform");
      expect(result.totalRequests).toBe(1);
    });

    it("ignores profiles without lastUsed", () => {
      const store = makeStore({
        usageStats: {
          "platform-openai": { errorCount: 5 }, // No lastUsed = no requests
        },
      });

      const result = extractMeterableUsage(store, "platform");
      expect(result.totalRequests).toBe(0);
    });
  });
});

// ── createUsageCollector integration tests ──────────────────────

const { createUsageCollector } = await import("./usage-collector.js");
const { listTenants } = await import("../tenants/tenant-store.js");
const { recordUsage } = await import("../billing/usage-metering.js");

const mockListTenants = vi.mocked(listTenants);
const mockRecordUsage = vi.mocked(recordUsage);

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

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "tenant-001",
    slug: "acme",
    displayName: "Acme Corp",
    status: "active" as const,
    plan: "pro" as const,
    credentialMode: "platform" as const,
    contactEmail: "admin@acme.com",
    gatewayContainerId: "openclaw-gw-acme",
    gatewayPort: 18789,
    gatewayHost: "openclaw-gw-acme.openclaw.svc.cluster.local",
    activityState: "active" as const,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

describe("createUsageCollector", () => {
  it("creates a collector with expected methods", () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });
    expect(collector.startCollector).toBeTypeOf("function");
    expect(collector.runCollectionCycle).toBeTypeOf("function");
    expect(collector.stopCollector).toBeTypeOf("function");
  });
});

describe("runCollectionCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects usage from a platform tenant gateway", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const tenant = makeTenant();
    mockListTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1, limit: 50, offset: 0 });

    const authProfileJson = JSON.stringify({
      version: 1,
      profiles: {
        "platform-openai": { type: "api_key", provider: "openai", key: "sk-test" },
      },
      usageStats: {
        "platform-openai": { lastUsed: Date.now(), errorCount: 10 },
      },
    });
    runtime.readGatewayFile.mockResolvedValueOnce(authProfileJson);
    mockRecordUsage.mockResolvedValueOnce(undefined);

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.collected).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockRecordUsage).toHaveBeenCalledOnce();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-001",
        date: "2026-03-20",
        provider: "openai",
        messageCount: 10,
      }),
    );
  });

  it("skips BYOK-only tenants (not metered)", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const byokTenant = makeTenant({ id: "tenant-byok", credentialMode: "byok" });
    mockListTenants.mockResolvedValueOnce({
      tenants: [byokTenant],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.skipped).toBe(1);
    expect(result.collected).toBe(0);
    expect(runtime.readGatewayFile).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("skips tenants without a gateway container", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const noGateway = makeTenant({ gatewayContainerId: undefined });
    mockListTenants.mockResolvedValueOnce({ tenants: [noGateway], total: 1, limit: 50, offset: 0 });

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.skipped).toBe(1);
    expect(runtime.readGatewayFile).not.toHaveBeenCalled();
  });

  it("handles gateway with no auth-profiles.json", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    mockListTenants.mockResolvedValueOnce({
      tenants: [makeTenant()],
      total: 1,
      limit: 50,
      offset: 0,
    });
    runtime.readGatewayFile.mockResolvedValueOnce(null);

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.skipped).toBe(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("computes delta across consecutive cycles (no double-counting)", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const tenant = makeTenant();

    // First cycle: 10 requests total.
    mockListTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1, limit: 50, offset: 0 });
    runtime.readGatewayFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        profiles: { "platform-openai": { type: "api_key", provider: "openai", key: "sk-x" } },
        usageStats: { "platform-openai": { lastUsed: Date.now(), errorCount: 10 } },
      }),
    );
    mockRecordUsage.mockResolvedValueOnce(undefined);

    const first = await collector.runCollectionCycle("2026-03-20");
    expect(first.collected).toBe(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(expect.objectContaining({ messageCount: 10 }));

    // Second cycle: 15 requests total (delta = 5).
    mockListTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1, limit: 50, offset: 0 });
    runtime.readGatewayFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        profiles: { "platform-openai": { type: "api_key", provider: "openai", key: "sk-x" } },
        usageStats: { "platform-openai": { lastUsed: Date.now(), errorCount: 15 } },
      }),
    );
    mockRecordUsage.mockResolvedValueOnce(undefined);

    const second = await collector.runCollectionCycle("2026-03-20");
    expect(second.collected).toBe(1);
    // Only the delta (5) should be recorded, not the full cumulative 15.
    expect(mockRecordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ messageCount: 5 }));
  });

  it("skips when no new usage since last cycle (delta = 0)", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const tenant = makeTenant();
    const storeJson = JSON.stringify({
      version: 1,
      profiles: { "platform-openai": { type: "api_key", provider: "openai", key: "sk-x" } },
      usageStats: { "platform-openai": { lastUsed: Date.now(), errorCount: 5 } },
    });

    // First cycle: 5 requests.
    mockListTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1, limit: 50, offset: 0 });
    runtime.readGatewayFile.mockResolvedValueOnce(storeJson);
    mockRecordUsage.mockResolvedValueOnce(undefined);
    await collector.runCollectionCycle("2026-03-20");

    vi.clearAllMocks();

    // Second cycle: same 5 requests (no new usage).
    mockListTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1, limit: 50, offset: 0 });
    runtime.readGatewayFile.mockResolvedValueOnce(storeJson);

    const result = await collector.runCollectionCycle("2026-03-20");
    expect(result.collected).toBe(0);
    expect(result.skipped).toBe(1); // Skipped because delta = 0.
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("processes multiple tenants with bounded concurrency", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime, concurrency: 2 });

    const tenants = [
      makeTenant({ id: "t-1", slug: "alpha", gatewayContainerId: "gw-alpha" }),
      makeTenant({ id: "t-2", slug: "beta", gatewayContainerId: "gw-beta" }),
      makeTenant({ id: "t-3", slug: "gamma", gatewayContainerId: "gw-gamma" }),
    ];
    mockListTenants.mockResolvedValueOnce({ tenants, total: 3, limit: 50, offset: 0 });

    const makeStoreJson = (provider: string) =>
      JSON.stringify({
        version: 1,
        profiles: { [`platform-${provider}`]: { type: "api_key", provider, key: "sk" } },
        usageStats: { [`platform-${provider}`]: { lastUsed: Date.now(), errorCount: 3 } },
      });

    runtime.readGatewayFile
      .mockResolvedValueOnce(makeStoreJson("openai"))
      .mockResolvedValueOnce(makeStoreJson("anthropic"))
      .mockResolvedValueOnce(makeStoreJson("openai"));
    mockRecordUsage.mockResolvedValue(undefined);

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.collected).toBe(3);
    expect(result.failed).toBe(0);
    expect(mockRecordUsage).toHaveBeenCalledTimes(3);
  });

  it("handles hybrid tenant — only meters platform profile usage", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const hybridTenant = makeTenant({ credentialMode: "hybrid" });
    mockListTenants.mockResolvedValueOnce({
      tenants: [hybridTenant],
      total: 1,
      limit: 50,
      offset: 0,
    });

    runtime.readGatewayFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        profiles: {
          "byok-openai-my-key-cred-001": { type: "api_key", provider: "openai", key: "sk-byok" },
          "platform-openai": { type: "api_key", provider: "openai", key: "sk-platform" },
        },
        usageStats: {
          "byok-openai-my-key-cred-001": { lastUsed: Date.now(), errorCount: 100 },
          "platform-openai": { lastUsed: Date.now(), errorCount: 7 },
        },
      }),
    );
    mockRecordUsage.mockResolvedValueOnce(undefined);

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.collected).toBe(1);
    // Only 7 platform requests should be metered, not 100 BYOK requests.
    expect(mockRecordUsage).toHaveBeenCalledWith(expect.objectContaining({ messageCount: 7 }));
  });

  it("counts failed gateways separately from collected", async () => {
    const runtime = makeMockRuntime();
    const collector = createUsageCollector({ runtime });

    const tenants = [
      makeTenant({ id: "t-ok", slug: "ok", gatewayContainerId: "gw-ok" }),
      makeTenant({ id: "t-fail", slug: "fail", gatewayContainerId: "gw-fail" }),
    ];
    mockListTenants.mockResolvedValueOnce({ tenants, total: 2, limit: 50, offset: 0 });

    runtime.readGatewayFile
      .mockResolvedValueOnce(
        JSON.stringify({
          version: 1,
          profiles: { "platform-openai": { type: "api_key", provider: "openai", key: "sk" } },
          usageStats: { "platform-openai": { lastUsed: Date.now(), errorCount: 5 } },
        }),
      )
      .mockRejectedValueOnce(new Error("container unreachable"));
    mockRecordUsage.mockResolvedValue(undefined);

    const result = await collector.runCollectionCycle("2026-03-20");

    expect(result.collected).toBe(1);
    expect(result.failed).toBe(1);
  });
});
