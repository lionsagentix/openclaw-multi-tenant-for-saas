import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies at the top level.
const mockValidateApiKey = vi.fn();

vi.mock("../../tenants/tenant-store.js", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { requireAuth, requireAdmin, requireTenant, asyncHandler, errorHandler } =
  await import("./middleware.js");

// ── Test Helpers ────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as Request;
}

function mockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

// ── Tests ───────────────────────────────────────────────────────

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no Authorization header", async () => {
    const middleware = requireAuth();
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect((res._body as { error: { type: string } }).error.type).toBe("unauthorized");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is not Bearer", async () => {
    const middleware = requireAuth();
    const req = mockReq({ headers: { authorization: "Basic abc123" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when API key is invalid", async () => {
    mockValidateApiKey.mockResolvedValueOnce(null);

    const middleware = requireAuth();
    const req = mockReq({ headers: { authorization: "Bearer oc_live_invalid" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(mockValidateApiKey).toHaveBeenCalledWith("oc_live_invalid");
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next with auth context for valid API key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      tenantId: "tenant-001",
      scope: "tenant",
      keyId: "key-001",
    });

    const middleware = requireAuth();
    const req = mockReq({ headers: { authorization: "Bearer oc_live_valid_key" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { auth: unknown }).auth).toEqual({
      tenantId: "tenant-001",
      scope: "tenant",
      keyId: "key-001",
    });
  });

  it("returns 403 when admin scope required but key is tenant-scoped", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      tenantId: "tenant-001",
      scope: "tenant",
      keyId: "key-001",
    });

    const middleware = requireAuth("admin");
    const req = mockReq({ headers: { authorization: "Bearer oc_live_tenant_key" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(403);
    expect((res._body as { error: { type: string } }).error.type).toBe("forbidden");
    expect(next).not.toHaveBeenCalled();
  });

  it("allows admin key to access tenant-scoped endpoints", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      tenantId: null,
      scope: "admin",
      keyId: "admin-key-001",
    });

    const middleware = requireAuth("tenant");
    const req = mockReq({ headers: { authorization: "Bearer oc_live_admin_key" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    // Admin can access tenant endpoints.
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireAdmin", () => {
  it("returns a middleware that requires admin scope", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      tenantId: null,
      scope: "admin",
      keyId: "admin-key",
    });

    const middleware = requireAdmin();
    const req = mockReq({ headers: { authorization: "Bearer oc_live_admin" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireTenant", () => {
  it("returns a middleware that accepts tenant scope", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      tenantId: "tenant-002",
      scope: "tenant",
      keyId: "key-002",
    });

    const middleware = requireTenant();
    const req = mockReq({ headers: { authorization: "Bearer oc_live_tenant" } });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("asyncHandler", () => {
  it("catches async errors and passes to next", async () => {
    const error = new Error("test error");
    const handler = asyncHandler(async () => {
      throw error;
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await handler(req, res, next);

    // asyncHandler uses .catch(next), so the error should be passed to next
    // after the promise resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledWith(error);
  });

  it("does not call next on success (handler sends response)", async () => {
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await handler(req, res, next);
    await new Promise((r) => setTimeout(r, 0));

    // next should NOT have been called because no error occurred
    // and the handler itself doesn't call next.
    expect(next).not.toHaveBeenCalled();
  });
});

describe("errorHandler", () => {
  it("returns 500 with structured error", () => {
    const err = new Error("something went wrong");
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res._status).toBe(500);
    expect((res._body as { error: { type: string } }).error.type).toBe("internal_error");
  });

  it("hides error details in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const err = new Error("secret details");
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, vi.fn());

    expect((res._body as { error: { message: string } }).error.message).toBe(
      "Internal server error.",
    );

    process.env.NODE_ENV = originalEnv;
  });
});
