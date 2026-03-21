/**
 * Control plane API barrel exports.
 */

export {
  createControlPlaneServer,
  type ControlPlaneServer,
  type ControlPlaneServerConfig,
} from "./server.js";
export { createAdminRoutes, type AdminRouteDeps } from "./admin-routes.js";
export { createTenantRoutes, type TenantRouteDeps } from "./tenant-routes.js";
export {
  requireAuth,
  requireAdmin,
  requireTenant,
  asyncHandler,
  errorHandler,
} from "./middleware.js";
export type { AuthContext, AuthenticatedRequest, ApiErrorResponse } from "./types.js";
