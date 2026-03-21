/**
 * API middleware for the control plane REST API.
 *
 * Provides:
 * - API key authentication with scope checking
 * - Async error handling wrapper
 * - Global error handler middleware
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { validateApiKey } from "../../tenants/tenant-store.js";
import type { ApiErrorResponse, AuthContext, AuthenticatedRequest } from "./types.js";

const log = createSubsystemLogger("control-plane/api");

// ── Response Helpers ────────────────────────────────────────────

/** Send a structured JSON error response. */
export function sendError(res: Response, status: number, response: ApiErrorResponse): void {
  res.status(status).json(response);
}

// ── Auth Middleware ──────────────────────────────────────────────

/**
 * Extract the Bearer token from the Authorization header.
 * Returns null if no valid Bearer token is present.
 */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim();
}

/**
 * Create an authentication middleware that validates API keys.
 *
 * @param requiredScope - If provided, only keys with this scope (or "admin") are allowed.
 *   Admin keys can always access tenant-scoped endpoints.
 */
export function requireAuth(requiredScope?: "admin" | "tenant"): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, 401, {
        error: {
          message: "Missing or invalid Authorization header. Expected: Bearer <api_key>",
          type: "unauthorized",
        },
      });
      return;
    }

    const result = await validateApiKey(token);
    if (!result) {
      sendError(res, 401, {
        error: { message: "Invalid or revoked API key.", type: "unauthorized" },
      });
      return;
    }

    // Admin scope can access everything. Tenant scope is restricted.
    if (requiredScope === "admin" && result.scope !== "admin") {
      sendError(res, 403, {
        error: { message: "Admin access required.", type: "forbidden" },
      });
      return;
    }

    // Attach auth context to the request.
    const authContext: AuthContext = {
      tenantId: result.tenantId,
      scope: result.scope,
      keyId: result.keyId,
    };
    (req as AuthenticatedRequest).auth = authContext;

    next();
  };
}

/** Shorthand: require admin scope. */
export function requireAdmin(): RequestHandler {
  return requireAuth("admin");
}

/** Shorthand: require at least tenant scope (admin also allowed). */
export function requireTenant(): RequestHandler {
  return requireAuth("tenant");
}

// ── Async Handler Wrapper ──────────────────────────────────────

/**
 * Wrap an async route handler to properly catch and forward errors
 * to Express error handling middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ── Global Error Handler ──────────────────────────────────────

/**
 * Express error handling middleware.
 * Catches unhandled errors and returns a structured JSON response.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  log.error(`Unhandled error: ${err.message}`);

  // Don't leak internal details in production.
  const message = process.env.NODE_ENV === "production" ? "Internal server error." : err.message;

  sendError(res, 500, {
    error: { message, type: "internal_error" },
  });
}
