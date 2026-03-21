import type { Server } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────

const mockGetTenant = vi.fn();
const mockGetTenantQuotas = vi.fn();
const mockWriteAuditLog = vi.fn();
const mockGetUsageSummary = vi.fn();
const mockGetActiveBillingSubscription = vi.fn();
const mockGetQuotaStatus = vi.fn();
const mockCreateTenantCredential = vi.fn();
const mockGetTenantCredentials = vi.fn();
const mockGetTenantCredential = vi.fn();
const mockDeleteTenantCredential = vi.fn();

vi.mock("../../tenants/tenant-store.js", () => ({
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
  getTenantQuotas: (...args: unknown[]) => mockGetTenantQuotas(...args),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

vi.mock("../../billing/billing-store.js", () => ({
  getUsageSummary: (...args: unknown[]) => mockGetUsageSummary(...args),
  getActiveBillingSubscription: (...args: unknown[]) => mockGetActiveBillingSubscription(...args),
}));

vi.mock("../../billing/quota-enforcement.js", () => ({
  getQuotaStatus: (...args: unknown[]) => mockGetQuotaStatus(...args),
}));

vi.mock("../../credentials/credential-store.js", () => ({
  createTenantCredential: (...args: unknown[]) => mockCreateTenantCredential(...args),
  getTenantCredentials: (...args: unknown[]) => mockGetTenantCredentials(...args),
  getTenantCredential: (...args: unknown[]) => mockGetTenantCredential(...args),
  deleteTenantCredential: (...args: unknown[]) => mockDeleteTenantCredential(...args),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createTenantRoutes } = await import("./tenant-routes.js");

// ── Test Helpers ────────────────────────────────────────────────

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "tenant-001",
    slug: "acme",
    displayName: "Acme Corp",
    status: "active",
    plan: "pro",
    credentialMode: "hybrid",
    contactEmail: "admin@acme.com",
    gatewayContainerId: "gw-acme",
    activityState: "active",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function createTestApp(authScope: "tenant" | "admin" = "tenant") {
  const mockOrchestrator = {
    provisionTenant: vi.fn(),
    deprovisionTenant: vi.fn(),
    stopTenantGateway: vi.fn(),
    startTenantGateway: vi.fn(),
    restartTenantGateway: vi.fn(),
    getTenantGatewayStatus: vi.fn(),
    getTenantGatewayLogs: vi.fn(),
  };

  const mockCredentialSync = {
    syncCredentialsToGateway: vi.fn().mockResolvedValue(undefined),
  };

  const app = express();
  app.use(express.json());

  // Simulate auth middleware.
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = {
      tenantId: authScope === "tenant" ? "tenant-001" : null,
      scope: authScope,
      keyId: authScope === "tenant" ? "key-001" : "admin-key",
    };
    next();
  });

  const routes = createTenantRoutes({
    orchestrator: mockOrchestrator,
    credentialSync: mockCredentialSync,
  });
  app.use("/api/v1/tenant", routes);

  return { app, mockOrchestrator, mockCredentialSync };
}

async function request(
  app: express.Application,
  method: "get" | "post" | "delete",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}${path}`;

      const fetchOpts: RequestInit = { method: method.toUpperCase() };
      if (body) {
        fetchOpts.headers = { "Content-Type": "application/json" };
        fetchOpts.body = JSON.stringify(body);
      }

      fetch(url, fetchOpts)
        .then(async (res) => {
          const json = await res.json();
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          throw err;
        });
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe("tenant-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  describe("GET /api/v1/tenant/usage", () => {
    it("returns usage summary for the authenticated tenant", async () => {
      const { app } = createTestApp();

      mockGetUsageSummary.mockResolvedValueOnce({
        tenantId: "tenant-001",
        totalTokens: 50000,
        totalMessages: 100,
        totalCostUsd: 0.5,
      });

      const res = await request(app, "get", "/api/v1/tenant/usage");

      expect(res.status).toBe(200);
      expect((res.body as { usage: { tenantId: string } }).usage.tenantId).toBe("tenant-001");
      expect(mockGetUsageSummary).toHaveBeenCalledWith(
        "tenant-001",
        expect.any(String),
        expect.any(String),
      );
    });

    it("returns 400 for admin key without tenantId query", async () => {
      const { app } = createTestApp("admin");

      const res = await request(app, "get", "/api/v1/tenant/usage");

      expect(res.status).toBe(400);
      expect((res.body as { error: { type: string } }).error.type).toBe("validation_error");
    });
  });

  describe("GET /api/v1/tenant/billing", () => {
    it("returns billing status with subscription and quotas", async () => {
      const { app } = createTestApp();

      mockGetTenant.mockResolvedValueOnce(makeTenant());
      mockGetActiveBillingSubscription.mockResolvedValueOnce({
        id: "sub-001",
        status: "active",
        planId: "pro_monthly",
      });
      mockGetTenantQuotas.mockResolvedValueOnce({
        maxMessagesPerDay: 10000,
        maxTokensPerDay: 10000000,
      });
      mockGetQuotaStatus.mockResolvedValueOnce([
        { quotaId: "messages_per_day", currentValue: 500, limit: 10000, percentUsed: 5 },
      ]);
      mockGetUsageSummary.mockResolvedValueOnce({
        totalTokens: 50000,
        totalMessages: 500,
      });

      const res = await request(app, "get", "/api/v1/tenant/billing");

      expect(res.status).toBe(200);
      const body = res.body as {
        tenant: { plan: string };
        subscription: { status: string };
        quotaStatus: unknown[];
      };
      expect(body.tenant.plan).toBe("pro");
      expect(body.subscription.status).toBe("active");
      expect(body.quotaStatus).toHaveLength(1);
    });
  });

  describe("POST /api/v1/tenant/credentials", () => {
    it("creates a BYOK credential and triggers sync", async () => {
      const { app, mockCredentialSync } = createTestApp();

      mockGetTenant.mockResolvedValueOnce(makeTenant({ credentialMode: "hybrid" }));
      mockCreateTenantCredential.mockResolvedValueOnce({
        id: "cred-001",
        tenantId: "tenant-001",
        provider: "openai",
        keyPrefix: "sk-proj-",
        createdAt: "2026-03-20T00:00:00Z",
      });

      const res = await request(app, "post", "/api/v1/tenant/credentials", {
        provider: "openai",
        apiKey: "sk-proj-test123abc",
        label: "My Key",
      });

      expect(res.status).toBe(201);
      expect((res.body as { credential: { id: string } }).credential.id).toBe("cred-001");
      expect(mockCredentialSync.syncCredentialsToGateway).toHaveBeenCalledWith("tenant-001");
    });

    it("returns 400 when provider is missing", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/v1/tenant/credentials", {
        apiKey: "sk-test123abc",
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when apiKey is too short", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/v1/tenant/credentials", {
        provider: "openai",
        apiKey: "short",
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when tenant is in platform mode", async () => {
      const { app } = createTestApp();

      mockGetTenant.mockResolvedValueOnce(makeTenant({ credentialMode: "platform" }));

      const res = await request(app, "post", "/api/v1/tenant/credentials", {
        provider: "openai",
        apiKey: "sk-proj-test123abc",
      });

      expect(res.status).toBe(400);
      expect((res.body as { error: { message: string } }).error.message).toContain(
        "platform credential mode",
      );
    });

    it("includes warning when sync fails", async () => {
      const { app, mockCredentialSync } = createTestApp();

      mockGetTenant.mockResolvedValueOnce(makeTenant({ credentialMode: "byok" }));
      mockCreateTenantCredential.mockResolvedValueOnce({
        id: "cred-002",
        tenantId: "tenant-001",
        provider: "openai",
      });
      mockCredentialSync.syncCredentialsToGateway.mockRejectedValueOnce(
        new Error("Gateway unreachable"),
      );

      const res = await request(app, "post", "/api/v1/tenant/credentials", {
        provider: "openai",
        apiKey: "sk-proj-test123abc",
      });

      expect(res.status).toBe(201);
      expect((res.body as { warning: string }).warning).toContain("sync failed");
    });
  });

  describe("GET /api/v1/tenant/credentials", () => {
    it("lists tenant credentials", async () => {
      const { app } = createTestApp();

      mockGetTenantCredentials.mockResolvedValueOnce([
        { id: "cred-001", provider: "openai", keyPrefix: "sk-proj-" },
        { id: "cred-002", provider: "anthropic", keyPrefix: "sk-ant-" },
      ]);

      const res = await request(app, "get", "/api/v1/tenant/credentials");

      expect(res.status).toBe(200);
      expect((res.body as { credentials: unknown[] }).credentials).toHaveLength(2);
    });
  });

  describe("DELETE /api/v1/tenant/credentials/:id", () => {
    it("revokes a credential and triggers sync", async () => {
      const { app, mockCredentialSync } = createTestApp();

      mockGetTenantCredential.mockResolvedValueOnce({
        id: "cred-001",
        tenantId: "tenant-001",
        provider: "openai",
      });
      mockDeleteTenantCredential.mockResolvedValueOnce(undefined);

      const res = await request(app, "delete", "/api/v1/tenant/credentials/cred-001");

      expect(res.status).toBe(200);
      expect(mockDeleteTenantCredential).toHaveBeenCalledWith("cred-001", "key-001");
      expect(mockCredentialSync.syncCredentialsToGateway).toHaveBeenCalledWith("tenant-001");
    });

    it("returns 404 for nonexistent credential", async () => {
      const { app } = createTestApp();
      mockGetTenantCredential.mockResolvedValueOnce(null);

      const res = await request(app, "delete", "/api/v1/tenant/credentials/nonexistent");

      expect(res.status).toBe(404);
    });

    it("returns 403 when credential belongs to different tenant", async () => {
      const { app } = createTestApp();

      mockGetTenantCredential.mockResolvedValueOnce({
        id: "cred-001",
        tenantId: "other-tenant",
        provider: "openai",
      });

      const res = await request(app, "delete", "/api/v1/tenant/credentials/cred-001");

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/tenant/gateway/status", () => {
    it("returns gateway status", async () => {
      const { app, mockOrchestrator } = createTestApp();

      mockOrchestrator.getTenantGatewayStatus.mockResolvedValueOnce({
        running: true,
        ready: true,
        state: "running",
        restartCount: 0,
      });

      const res = await request(app, "get", "/api/v1/tenant/gateway/status");

      expect(res.status).toBe(200);
      expect((res.body as { gateway: { running: boolean } }).gateway.running).toBe(true);
    });
  });
});
