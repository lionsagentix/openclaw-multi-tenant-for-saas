import type { Server } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────

const mockGetTenant = vi.fn();
const mockListTenants = vi.fn();
const mockSuspendTenant = vi.fn();
const mockResumeTenant = vi.fn();
const mockUpdateTenant = vi.fn();
const mockWriteAuditLog = vi.fn();

vi.mock("../../tenants/tenant-store.js", () => ({
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
  listTenants: (...args: unknown[]) => mockListTenants(...args),
  suspendTenant: (...args: unknown[]) => mockSuspendTenant(...args),
  resumeTenant: (...args: unknown[]) => mockResumeTenant(...args),
  updateTenant: (...args: unknown[]) => mockUpdateTenant(...args),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createAdminRoutes } = await import("./admin-routes.js");

// ── Test Helpers ────────────────────────────────────────────────

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "tenant-001",
    slug: "acme",
    displayName: "Acme Corp",
    status: "active",
    plan: "pro",
    credentialMode: "platform",
    contactEmail: "admin@acme.com",
    gatewayContainerId: "gw-acme",
    activityState: "active",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function createTestApp() {
  const mockOrchestrator = {
    provisionTenant: vi.fn(),
    deprovisionTenant: vi.fn(),
    stopTenantGateway: vi.fn(),
    startTenantGateway: vi.fn(),
    restartTenantGateway: vi.fn(),
    getTenantGatewayStatus: vi.fn(),
    getTenantGatewayLogs: vi.fn(),
  };

  const app = express();
  app.use(express.json());

  // Simulate auth middleware by injecting auth context.
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = {
      tenantId: null,
      scope: "admin",
      keyId: "admin-key-001",
    };
    next();
  });

  const adminRoutes = createAdminRoutes({ orchestrator: mockOrchestrator });
  app.use("/api/v1/tenants", adminRoutes);

  return { app, mockOrchestrator };
}

async function request(
  app: express.Application,
  method: "get" | "post" | "patch" | "delete",
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

describe("admin-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  describe("POST /api/v1/tenants", () => {
    it("provisions a tenant and returns 201", async () => {
      const { app, mockOrchestrator } = createTestApp();

      mockOrchestrator.provisionTenant.mockResolvedValueOnce({
        tenant: makeTenant(),
        controlPlaneApiKey: "oc_live_test_key",
        gatewayToken: "gw_test_token",
      });

      const res = await request(app, "post", "/api/v1/tenants", {
        slug: "acme",
        contactEmail: "admin@acme.com",
        plan: "pro",
        credentialMode: "platform",
      });

      expect(res.status).toBe(201);
      expect((res.body as { tenant: { slug: string } }).tenant.slug).toBe("acme");
      expect((res.body as { controlPlaneApiKey: string }).controlPlaneApiKey).toBe(
        "oc_live_test_key",
      );
    });

    it("returns 400 when slug is missing", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/v1/tenants", {
        contactEmail: "admin@acme.com",
        plan: "pro",
        credentialMode: "platform",
      });

      expect(res.status).toBe(400);
      expect((res.body as { error: { type: string } }).error.type).toBe("validation_error");
    });

    it("returns 400 for invalid plan", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/v1/tenants", {
        slug: "acme",
        contactEmail: "admin@acme.com",
        plan: "invalid",
        credentialMode: "platform",
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid credentialMode", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/api/v1/tenants", {
        slug: "acme",
        contactEmail: "admin@acme.com",
        plan: "pro",
        credentialMode: "invalid",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/tenants", () => {
    it("returns paginated tenant list", async () => {
      const { app } = createTestApp();

      mockListTenants.mockResolvedValueOnce({
        tenants: [makeTenant()],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const res = await request(app, "get", "/api/v1/tenants");

      expect(res.status).toBe(200);
      expect((res.body as { tenants: unknown[] }).tenants).toHaveLength(1);
      expect((res.body as { total: number }).total).toBe(1);
    });

    it("passes query params to listTenants", async () => {
      const { app } = createTestApp();

      mockListTenants.mockResolvedValueOnce({
        tenants: [],
        total: 0,
        limit: 10,
        offset: 0,
      });

      await request(app, "get", "/api/v1/tenants?status=active&plan=pro&limit=10");

      expect(mockListTenants).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "active",
          plan: "pro",
          limit: 10,
        }),
      );
    });
  });

  describe("GET /api/v1/tenants/:id", () => {
    it("returns tenant details", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant());

      const res = await request(app, "get", "/api/v1/tenants/tenant-001");

      expect(res.status).toBe(200);
      expect((res.body as { tenant: { id: string } }).tenant.id).toBe("tenant-001");
    });

    it("returns 404 for nonexistent tenant", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(null);

      const res = await request(app, "get", "/api/v1/tenants/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/v1/tenants/:id", () => {
    it("updates tenant fields", async () => {
      const { app } = createTestApp();
      const tenant = makeTenant();
      mockGetTenant.mockResolvedValueOnce(tenant);
      mockUpdateTenant.mockResolvedValueOnce({ ...tenant, displayName: "New Name" });

      const res = await request(app, "patch", "/api/v1/tenants/tenant-001", {
        displayName: "New Name",
      });

      expect(res.status).toBe(200);
      expect(mockUpdateTenant).toHaveBeenCalledWith("tenant-001", { displayName: "New Name" });
    });

    it("returns 404 if tenant not found", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(null);

      const res = await request(app, "patch", "/api/v1/tenants/nonexistent", {
        displayName: "New",
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/tenants/:id/suspend", () => {
    it("suspends an active tenant", async () => {
      const { app, mockOrchestrator } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant());
      mockOrchestrator.stopTenantGateway.mockResolvedValueOnce(undefined);
      mockSuspendTenant.mockResolvedValueOnce(makeTenant({ status: "suspended" }));

      const res = await request(app, "post", "/api/v1/tenants/tenant-001/suspend", {
        reason: "Testing",
      });

      expect(res.status).toBe(200);
      expect(mockSuspendTenant).toHaveBeenCalledWith("tenant-001", "Testing");
    });

    it("returns 400 if already suspended", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant({ status: "suspended" }));

      const res = await request(app, "post", "/api/v1/tenants/tenant-001/suspend");

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/tenants/:id/resume", () => {
    it("resumes a suspended tenant", async () => {
      const { app, mockOrchestrator } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant({ status: "suspended" }));
      mockResumeTenant.mockResolvedValueOnce(makeTenant({ status: "active" }));
      mockOrchestrator.startTenantGateway.mockResolvedValueOnce(undefined);

      const res = await request(app, "post", "/api/v1/tenants/tenant-001/resume");

      expect(res.status).toBe(200);
      expect(mockResumeTenant).toHaveBeenCalledWith("tenant-001");
    });

    it("returns 400 if not suspended", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant({ status: "active" }));

      const res = await request(app, "post", "/api/v1/tenants/tenant-001/resume");

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/v1/tenants/:id", () => {
    it("deprovisions a tenant", async () => {
      const { app, mockOrchestrator } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(makeTenant());
      mockOrchestrator.deprovisionTenant.mockResolvedValueOnce(undefined);

      const res = await request(app, "delete", "/api/v1/tenants/tenant-001");

      expect(res.status).toBe(200);
      expect(mockOrchestrator.deprovisionTenant).toHaveBeenCalledWith(
        "tenant-001",
        "admin-key-001",
      );
    });

    it("returns 404 for nonexistent tenant", async () => {
      const { app } = createTestApp();
      mockGetTenant.mockResolvedValueOnce(null);

      const res = await request(app, "delete", "/api/v1/tenants/nonexistent");

      expect(res.status).toBe(404);
    });
  });
});
