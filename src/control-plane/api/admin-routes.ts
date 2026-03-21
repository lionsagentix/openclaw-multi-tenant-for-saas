/**
 * Admin REST API routes for tenant management.
 *
 * All routes require admin-scoped API key authentication.
 * Routes delegate to the orchestrator for lifecycle operations
 * and to the tenant store for CRUD operations.
 */

import { Router, type Request, type Response } from "express";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getTenant,
  listTenants,
  suspendTenant,
  resumeTenant,
  updateTenant,
  writeAuditLog,
} from "../../tenants/tenant-store.js";
import type { TenantCredentialMode, TenantPlan, TenantStatus } from "../../tenants/types.js";
import type { Orchestrator } from "../orchestrator.js";
import { asyncHandler, sendError } from "./middleware.js";
import type {
  AuthenticatedRequest,
  CreateTenantBody,
  SuspendTenantBody,
  UpdateTenantBody,
} from "./types.js";

const log = createSubsystemLogger("control-plane/api/admin");

const VALID_PLANS: TenantPlan[] = ["free", "starter", "pro", "enterprise"];
const VALID_CREDENTIAL_MODES: TenantCredentialMode[] = ["platform", "byok", "hybrid"];
const VALID_STATUSES: TenantStatus[] = [
  "provisioning",
  "active",
  "suspended",
  "deprovisioning",
  "deleted",
];

export type AdminRouteDeps = {
  orchestrator: Orchestrator;
};

/**
 * Create admin routes for tenant management.
 *
 * Mounted at `/api/v1/tenants` with admin auth middleware applied upstream.
 */
export function createAdminRoutes(deps: AdminRouteDeps): Router {
  const { orchestrator } = deps;
  const router = Router();

  // ── POST / — Create tenant + provision gateway ──────────────

  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const body = req.body as CreateTenantBody;

      // Validate required fields.
      if (!body.slug || typeof body.slug !== "string") {
        sendError(res, 400, {
          error: { message: "slug is required and must be a string.", type: "validation_error" },
        });
        return;
      }
      if (!body.contactEmail || typeof body.contactEmail !== "string") {
        sendError(res, 400, {
          error: {
            message: "contactEmail is required and must be a string.",
            type: "validation_error",
          },
        });
        return;
      }
      if (!body.plan || !VALID_PLANS.includes(body.plan)) {
        sendError(res, 400, {
          error: {
            message: `plan must be one of: ${VALID_PLANS.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }
      if (!body.credentialMode || !VALID_CREDENTIAL_MODES.includes(body.credentialMode)) {
        sendError(res, 400, {
          error: {
            message: `credentialMode must be one of: ${VALID_CREDENTIAL_MODES.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }

      const displayName = body.displayName || body.slug;

      try {
        const result = await orchestrator.provisionTenant(
          {
            slug: body.slug,
            displayName,
            plan: body.plan,
            credentialMode: body.credentialMode,
            contactEmail: body.contactEmail,
            metadata: body.metadata,
          },
          auth.keyId,
        );

        log.info(`Tenant ${result.tenant.slug} provisioned by ${auth.keyId}.`);

        res.status(201).json({
          tenant: result.tenant,
          controlPlaneApiKey: result.controlPlaneApiKey,
          gatewayToken: result.gatewayToken,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Distinguish known validation errors from unexpected failures.
        if (message.includes("already exists") || message.includes("slug")) {
          sendError(res, 409, {
            error: { message, type: "validation_error" },
          });
          return;
        }

        log.error(`Failed to provision tenant: ${message}`);
        sendError(res, 500, {
          error: { message: "Failed to provision tenant.", type: "internal_error" },
        });
      }
    }),
  );

  // ── GET / — List tenants (paginated) ────────────────────────

  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const { status, plan, search, limit, offset } = req.query as Record<string, string>;

      // Validate optional enum filters.
      if (status && !VALID_STATUSES.includes(status as TenantStatus)) {
        sendError(res, 400, {
          error: {
            message: `status must be one of: ${VALID_STATUSES.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }
      if (plan && !VALID_PLANS.includes(plan as TenantPlan)) {
        sendError(res, 400, {
          error: {
            message: `plan must be one of: ${VALID_PLANS.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }

      const result = await listTenants({
        status: status as TenantStatus,
        plan: plan as TenantPlan,
        search,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        offset: offset ? Number.parseInt(offset, 10) : undefined,
      });

      res.json(result);
    }),
  );

  // ── GET /:id — Get tenant details ──────────────────────────

  router.get(
    "/:id",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const id = req.params.id as string;
      const tenant = await getTenant(id);
      if (!tenant) {
        sendError(res, 404, {
          error: { message: `Tenant ${id} not found.`, type: "not_found" },
        });
        return;
      }
      res.json({ tenant });
    }),
  );

  // ── PATCH /:id — Update tenant config/plan ──────────────────

  router.patch(
    "/:id",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const body = req.body as UpdateTenantBody;
      const tenantId = req.params.id as string;

      // Verify tenant exists.
      const existing = await getTenant(tenantId);
      if (!existing) {
        sendError(res, 404, {
          error: { message: `Tenant ${tenantId} not found.`, type: "not_found" },
        });
        return;
      }

      // Validate provided fields.
      if (body.plan && !VALID_PLANS.includes(body.plan)) {
        sendError(res, 400, {
          error: {
            message: `plan must be one of: ${VALID_PLANS.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }
      if (body.credentialMode && !VALID_CREDENTIAL_MODES.includes(body.credentialMode)) {
        sendError(res, 400, {
          error: {
            message: `credentialMode must be one of: ${VALID_CREDENTIAL_MODES.join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }

      const updated = await updateTenant(tenantId, body);

      await writeAuditLog({
        tenantId,
        actor: auth.keyId,
        action: "tenant.update",
        resourceType: "tenant",
        resourceId: tenantId,
        details: { fields: Object.keys(body) },
      });

      res.json({ tenant: updated });
    }),
  );

  // ── POST /:id/suspend — Suspend tenant ─────────────────────

  router.post(
    "/:id/suspend",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const body = (req.body || {}) as SuspendTenantBody;
      const tenantId = req.params.id as string;

      const existing = await getTenant(tenantId);
      if (!existing) {
        sendError(res, 404, {
          error: { message: `Tenant ${tenantId} not found.`, type: "not_found" },
        });
        return;
      }

      if (existing.status === "suspended") {
        sendError(res, 400, {
          error: { message: "Tenant is already suspended.", type: "validation_error" },
        });
        return;
      }

      // Stop the gateway container first.
      if (existing.gatewayContainerId) {
        try {
          await orchestrator.stopTenantGateway(tenantId, auth.keyId);
        } catch (err) {
          log.warn(
            `Failed to stop gateway for ${existing.slug}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const reason = body.reason || "Manually suspended via admin API";
      const tenant = await suspendTenant(tenantId, reason);

      log.info(`Tenant ${existing.slug} suspended by ${auth.keyId}: ${reason}`);
      res.json({ tenant });
    }),
  );

  // ── POST /:id/resume — Resume suspended tenant ─────────────

  router.post(
    "/:id/resume",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const tenantId = req.params.id as string;

      const existing = await getTenant(tenantId);
      if (!existing) {
        sendError(res, 404, {
          error: { message: `Tenant ${tenantId} not found.`, type: "not_found" },
        });
        return;
      }

      if (existing.status !== "suspended") {
        sendError(res, 400, {
          error: { message: "Tenant is not suspended.", type: "validation_error" },
        });
        return;
      }

      const tenant = await resumeTenant(tenantId);

      // Start the gateway container.
      if (existing.gatewayContainerId) {
        try {
          await orchestrator.startTenantGateway(tenantId, auth.keyId);
        } catch (err) {
          log.warn(
            `Failed to start gateway for ${existing.slug}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      log.info(`Tenant ${existing.slug} resumed by ${auth.keyId}.`);
      res.json({ tenant });
    }),
  );

  // ── DELETE /:id — Decommission tenant ──────────────────────

  router.delete(
    "/:id",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const tenantId = req.params.id as string;

      const existing = await getTenant(tenantId);
      if (!existing) {
        sendError(res, 404, {
          error: { message: `Tenant ${tenantId} not found.`, type: "not_found" },
        });
        return;
      }

      try {
        await orchestrator.deprovisionTenant(tenantId, auth.keyId);
        log.info(`Tenant ${existing.slug} deprovisioned by ${auth.keyId}.`);
        res.json({ message: `Tenant ${existing.slug} deprovisioned.`, tenantId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to deprovision tenant ${existing.slug}: ${message}`);
        sendError(res, 500, {
          error: { message: "Failed to deprovision tenant.", type: "internal_error" },
        });
      }
    }),
  );

  return router;
}
