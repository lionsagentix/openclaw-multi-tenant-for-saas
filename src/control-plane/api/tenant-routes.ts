/**
 * Tenant self-service REST API routes.
 *
 * These routes are scoped to the authenticated tenant's data.
 * The tenant ID comes from the API key (req.auth.tenantId),
 * not from URL parameters — preventing cross-tenant access.
 *
 * Admin-scoped keys can also call these endpoints but must
 * provide a tenantId query parameter to specify which tenant.
 */

import { Router, type Request, type Response } from "express";
import { getActiveBillingSubscription, getUsageSummary } from "../../billing/billing-store.js";
import { getQuotaStatus } from "../../billing/quota-enforcement.js";
import {
  createTenantCredential,
  getTenantCredentials,
  getTenantCredential,
  deleteTenantCredential,
} from "../../credentials/credential-store.js";
import type { CredentialSync } from "../../credentials/credential-sync.js";
import { KNOWN_BYOK_PROVIDERS } from "../../credentials/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getTenant, getTenantQuotas } from "../../tenants/tenant-store.js";
import type { Orchestrator } from "../orchestrator.js";
import { asyncHandler, sendError } from "./middleware.js";
import type { AuthenticatedRequest, CreateCredentialBody } from "./types.js";

const log = createSubsystemLogger("control-plane/api/tenant");

export type TenantRouteDeps = {
  orchestrator: Orchestrator;
  credentialSync: CredentialSync;
};

/**
 * Resolve the target tenant ID for a self-service request.
 *
 * For tenant-scoped keys: uses the key's associated tenantId.
 * For admin-scoped keys: requires a `tenantId` query parameter.
 */
function resolvetenantId(req: Request): string | null {
  const auth = (req as AuthenticatedRequest).auth;

  if (auth.scope === "admin") {
    // Admin keys must specify which tenant they're acting on.
    const queryTenantId = req.query.tenantId as string | undefined;
    return queryTenantId || null;
  }

  return auth.tenantId;
}

/**
 * Create tenant self-service routes.
 *
 * Mounted at `/api/v1/tenant` with tenant auth middleware applied upstream.
 */
export function createTenantRoutes(deps: TenantRouteDeps): Router {
  const { orchestrator, credentialSync } = deps;
  const router = Router();

  // ── GET /usage — Current usage summary ──────────────────────

  router.get(
    "/usage",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: {
            message: "tenantId is required (provide via query parameter for admin keys).",
            type: "validation_error",
          },
        });
        return;
      }

      // Default to current month.
      const now = new Date();
      const startDate =
        (req.query.startDate as string) ||
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().split("T")[0];
      const endDate = (req.query.endDate as string) || now.toISOString().split("T")[0];

      const summary = await getUsageSummary(tenantId, startDate, endDate);
      res.json({ usage: summary });
    }),
  );

  // ── GET /billing — Billing status + invoices ────────────────

  router.get(
    "/billing",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: {
            message: "tenantId is required (provide via query parameter for admin keys).",
            type: "validation_error",
          },
        });
        return;
      }

      const tenant = await getTenant(tenantId);
      if (!tenant) {
        sendError(res, 404, {
          error: { message: "Tenant not found.", type: "not_found" },
        });
        return;
      }

      const [subscription, quotas, quotaStatus] = await Promise.all([
        getActiveBillingSubscription(tenantId),
        getTenantQuotas(tenantId),
        getQuotaStatus(tenantId),
      ]);

      // Current month usage summary.
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .split("T")[0];
      const today = now.toISOString().split("T")[0];
      const currentUsage = await getUsageSummary(tenantId, monthStart, today);

      res.json({
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          plan: tenant.plan,
          credentialMode: tenant.credentialMode,
          status: tenant.status,
        },
        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              planId: subscription.planId,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            }
          : null,
        quotas,
        quotaStatus,
        currentMonthUsage: currentUsage,
      });
    }),
  );

  // ── POST /credentials — Upload BYOK API key ────────────────

  router.post(
    "/credentials",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: {
            message: "tenantId is required.",
            type: "validation_error",
          },
        });
        return;
      }

      const body = req.body as CreateCredentialBody;

      // Validate required fields.
      if (!body.provider || typeof body.provider !== "string") {
        sendError(res, 400, {
          error: {
            message: `provider is required. Known providers: ${[...KNOWN_BYOK_PROVIDERS].join(", ")}`,
            type: "validation_error",
          },
        });
        return;
      }
      if (!body.apiKey || typeof body.apiKey !== "string") {
        sendError(res, 400, {
          error: { message: "apiKey is required and must be a string.", type: "validation_error" },
        });
        return;
      }
      if (body.apiKey.length < 8) {
        sendError(res, 400, {
          error: { message: "apiKey must be at least 8 characters.", type: "validation_error" },
        });
        return;
      }

      // Verify tenant's credential mode allows BYOK.
      const tenant = await getTenant(tenantId);
      if (!tenant) {
        sendError(res, 404, {
          error: { message: "Tenant not found.", type: "not_found" },
        });
        return;
      }
      if (tenant.credentialMode === "platform") {
        sendError(res, 400, {
          error: {
            message:
              "Cannot add BYOK credentials in platform credential mode. Change to 'byok' or 'hybrid' first.",
            type: "validation_error",
          },
        });
        return;
      }

      const credential = await createTenantCredential(
        {
          tenantId,
          provider: body.provider,
          apiKey: body.apiKey,
          label: body.label,
        },
        auth.keyId,
      );

      // Trigger credential sync to gateway (best-effort).
      let syncWarning: string | undefined;
      try {
        await credentialSync.syncCredentialsToGateway(tenantId);
      } catch (err) {
        syncWarning = `Credential saved but gateway sync failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`Credential sync failed for tenant ${tenantId}: ${syncWarning}`);
      }

      log.info(
        `Credential ${credential.id} (${credential.provider}) created for tenant ${tenantId}.`,
      );

      res.status(201).json({
        credential,
        ...(syncWarning ? { warning: syncWarning } : {}),
      });
    }),
  );

  // ── GET /credentials — List tenant credentials ──────────────

  router.get(
    "/credentials",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: {
            message: "tenantId is required.",
            type: "validation_error",
          },
        });
        return;
      }

      const credentials = await getTenantCredentials(tenantId);
      res.json({ credentials });
    }),
  );

  // ── DELETE /credentials/:id — Remove a BYOK key ────────────

  router.delete(
    "/credentials/:id",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const auth = (req as AuthenticatedRequest).auth;
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: { message: "tenantId is required.", type: "validation_error" },
        });
        return;
      }

      const credentialId = req.params.id as string;

      // Verify credential exists and belongs to this tenant.
      const credential = await getTenantCredential(credentialId);
      if (!credential) {
        sendError(res, 404, {
          error: { message: `Credential ${credentialId} not found.`, type: "not_found" },
        });
        return;
      }
      if (credential.tenantId !== tenantId) {
        sendError(res, 403, {
          error: {
            message: "Credential does not belong to this tenant.",
            type: "forbidden",
          },
        });
        return;
      }

      await deleteTenantCredential(credentialId, auth.keyId);

      // Trigger credential sync to gateway (best-effort).
      let syncWarning: string | undefined;
      try {
        await credentialSync.syncCredentialsToGateway(tenantId);
      } catch (err) {
        syncWarning = `Credential revoked but gateway sync failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`Credential sync failed for tenant ${tenantId}: ${syncWarning}`);
      }

      log.info(`Credential ${credentialId} revoked for tenant ${tenantId}.`);

      res.json({
        message: `Credential ${credentialId} revoked.`,
        ...(syncWarning ? { warning: syncWarning } : {}),
      });
    }),
  );

  // ── GET /gateway/status — Gateway health status ─────────────

  router.get(
    "/gateway/status",
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const tenantId = resolvetenantId(req);
      if (!tenantId) {
        sendError(res, 400, {
          error: { message: "tenantId is required.", type: "validation_error" },
        });
        return;
      }

      const status = await orchestrator.getTenantGatewayStatus(tenantId);
      res.json({ gateway: status });
    }),
  );

  return router;
}
