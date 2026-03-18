/**
 * PostgreSQL-backed tenant CRUD operations.
 *
 * All database access for tenant records goes through this module.
 * Uses the shared connection pool from `src/control-plane/db.ts`.
 */

import crypto from "node:crypto";
import { getDb } from "../control-plane/db.js";
import { validateTenantSlug } from "./tenant-id.js";
import type {
  CreateTenantParams,
  Tenant,
  TenantActivityState,
  TenantId,
  TenantListParams,
  TenantListResult,
  TenantQuotas,
  TenantStatus,
} from "./types.js";

// ── Row-to-Type Mapping ────────────────────────────────────────

/** Map a database row to a Tenant object. */
function rowToTenant(row: Record<string, unknown>): Tenant {
  return {
    id: row.id as string,
    slug: row.slug as string,
    displayName: row.display_name as string,
    status: row.status as TenantStatus,
    plan: row.plan as Tenant["plan"],
    credentialMode: row.credential_mode as Tenant["credentialMode"],
    contactEmail: row.contact_email as string,
    gatewayContainerId: (row.gateway_container_id as string) || undefined,
    gatewayPort: (row.gateway_port as number) || undefined,
    gatewayHost: (row.gateway_host as string) || undefined,
    activityState: row.activity_state as TenantActivityState,
    lastActivityAt: row.last_activity_at ? (row.last_activity_at as Date).toISOString() : undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    suspendedAt: row.suspended_at ? (row.suspended_at as Date).toISOString() : undefined,
    suspendedReason: (row.suspended_reason as string) || undefined,
    metadata: (row.metadata as Record<string, string>) || undefined,
  };
}

function rowToQuotas(row: Record<string, unknown>): TenantQuotas {
  return {
    tenantId: row.tenant_id as string,
    maxAgents: row.max_agents as number,
    maxSessionsPerAgent: row.max_sessions_per_agent as number,
    maxMessagesPerDay: row.max_messages_per_day as number,
    maxTokensPerDay: Number(row.max_tokens_per_day),
    maxCostPerDayCents: row.max_cost_per_day_cents as number,
    maxCostPerMonthCents: row.max_cost_per_month_cents as number,
    maxChannels: row.max_channels as number,
    maxStorageBytes: Number(row.max_storage_bytes),
  };
}

// ── Tenant CRUD ────────────────────────────────────────────────

/**
 * Create a new tenant with default quotas based on plan.
 * Validates the slug before insertion.
 */
export async function createTenant(
  params: CreateTenantParams,
  planQuotas: Record<string, Omit<TenantQuotas, "tenantId">>,
): Promise<Tenant> {
  const db = getDb();

  // Validate slug.
  const slugValidation = validateTenantSlug(params.slug);
  if (!slugValidation.valid) {
    throw new Error(slugValidation.error);
  }
  const slug = slugValidation.slug;

  // Check for slug uniqueness.
  const existing = await db.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (existing.rows.length > 0) {
    throw new Error(`Tenant with slug "${slug}" already exists.`);
  }

  // Insert tenant and quotas in a transaction.
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const tenantResult = await client.query(
      `INSERT INTO tenants (slug, display_name, status, plan, credential_mode, contact_email, metadata)
       VALUES ($1, $2, 'provisioning', $3, $4, $5, $6)
       RETURNING *`,
      [
        slug,
        params.displayName,
        params.plan,
        params.credentialMode,
        params.contactEmail,
        JSON.stringify(params.metadata || {}),
      ],
    );

    const tenant = rowToTenant(tenantResult.rows[0]);

    // Insert default quotas for the tenant's plan.
    const quotas = planQuotas[tenant.plan];
    if (quotas) {
      await client.query(
        `INSERT INTO tenant_quotas
         (tenant_id, max_agents, max_sessions_per_agent, max_messages_per_day,
          max_tokens_per_day, max_cost_per_day_cents, max_cost_per_month_cents,
          max_channels, max_storage_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenant.id,
          quotas.maxAgents,
          quotas.maxSessionsPerAgent,
          quotas.maxMessagesPerDay,
          quotas.maxTokensPerDay,
          quotas.maxCostPerDayCents,
          quotas.maxCostPerMonthCents,
          quotas.maxChannels,
          quotas.maxStorageBytes,
        ],
      );
    }

    await client.query("COMMIT");
    return tenant;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Get a tenant by ID. Returns null if not found or soft-deleted. */
export async function getTenant(tenantId: TenantId): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query("SELECT * FROM tenants WHERE id = $1 AND deleted_at IS NULL", [
    tenantId,
  ]);
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

/** Get a tenant by slug. Returns null if not found or soft-deleted. */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query("SELECT * FROM tenants WHERE slug = $1 AND deleted_at IS NULL", [
    slug.toLowerCase(),
  ]);
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

/** Get a tenant's quotas. */
export async function getTenantQuotas(tenantId: TenantId): Promise<TenantQuotas | null> {
  const db = getDb();
  const result = await db.query("SELECT * FROM tenant_quotas WHERE tenant_id = $1", [tenantId]);
  return result.rows.length > 0 ? rowToQuotas(result.rows[0]) : null;
}

/** List tenants with optional filtering and pagination. */
export async function listTenants(params: TenantListParams = {}): Promise<TenantListResult> {
  const db = getDb();
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  const conditions: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex++}`);
    values.push(params.status);
  }

  if (params.plan) {
    conditions.push(`plan = $${paramIndex++}`);
    values.push(params.plan);
  }

  if (params.search) {
    conditions.push(`(slug ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex})`);
    values.push(`%${params.search}%`);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total matching tenants.
  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM tenants ${whereClause}`,
    values,
  );
  const total = Number(countResult.rows[0].total);

  // Fetch the page.
  const dataResult = await db.query(
    `SELECT * FROM tenants ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...values, limit, offset],
  );

  return {
    tenants: dataResult.rows.map(rowToTenant),
    total,
    limit,
    offset,
  };
}

// ── Status Transitions ─────────────────────────────────────────

/** Update a tenant's status. */
export async function updateTenantStatus(
  tenantId: TenantId,
  status: TenantStatus,
): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query(
    "UPDATE tenants SET status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *",
    [tenantId, status],
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

/** Suspend a tenant with a reason. */
export async function suspendTenant(tenantId: TenantId, reason: string): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query(
    `UPDATE tenants
     SET status = 'suspended', suspended_at = NOW(), suspended_reason = $2
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [tenantId, reason],
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

/** Resume a suspended tenant. */
export async function resumeTenant(tenantId: TenantId): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query(
    `UPDATE tenants
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL
     WHERE id = $1 AND status = 'suspended' AND deleted_at IS NULL
     RETURNING *`,
    [tenantId],
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

/** Soft-delete a tenant. */
export async function deleteTenant(tenantId: TenantId): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query(
    `UPDATE tenants
     SET status = 'deleted', deleted_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [tenantId],
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

// ── Gateway Info ───────────────────────────────────────────────

/** Update a tenant's gateway container information after provisioning. */
export async function updateTenantGateway(
  tenantId: TenantId,
  gateway: {
    containerId: string;
    port: number;
    host: string;
  },
): Promise<Tenant | null> {
  const db = getDb();
  const result = await db.query(
    `UPDATE tenants
     SET gateway_container_id = $2, gateway_port = $3, gateway_host = $4
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [tenantId, gateway.containerId, gateway.port, gateway.host],
  );
  return result.rows.length > 0 ? rowToTenant(result.rows[0]) : null;
}

// ── Activity Tracking ──────────────────────────────────────────

/** Record tenant activity (called on inbound message). */
export async function recordTenantActivity(tenantId: TenantId): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE tenants
     SET last_activity_at = NOW(), activity_state = 'active'
     WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
}

/** Update a tenant's activity state (for hibernation management). */
export async function updateTenantActivityState(
  tenantId: TenantId,
  state: TenantActivityState,
): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE tenants
     SET activity_state = $2
     WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId, state],
  );
}

/** Get tenants that are idle beyond the threshold (candidates for hibernation). */
export async function getIdleTenants(idleThresholdMinutes: number): Promise<Tenant[]> {
  const db = getDb();
  const result = await db.query(
    `SELECT * FROM tenants
     WHERE status = 'active'
       AND activity_state = 'active'
       AND deleted_at IS NULL
       AND (last_activity_at IS NULL OR last_activity_at < NOW() - ($1 || ' minutes')::INTERVAL)`,
    [idleThresholdMinutes],
  );
  return result.rows.map(rowToTenant);
}

// ── API Key Management ─────────────────────────────────────────

/**
 * Generate and store an API key for a tenant or admin.
 * Returns the full plaintext key (only time it's available).
 */
export async function createApiKey(params: {
  tenantId?: TenantId;
  scope: "admin" | "tenant";
  label?: string;
}): Promise<{ key: string; keyPrefix: string; id: string }> {
  const db = getDb();

  // Generate a random API key: "oc_live_" + 32 hex chars.
  const rawKey = crypto.randomBytes(32).toString("hex");
  const key = `oc_live_${rawKey}`;
  const keyPrefix = key.slice(0, 16);
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");

  const result = await db.query(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.tenantId || null, keyHash, keyPrefix, params.scope, params.label || null],
  );

  return {
    key, // Full plaintext key — only returned once.
    keyPrefix,
    id: result.rows[0].id as string,
  };
}

/**
 * Validate an API key and return the associated tenant ID and scope.
 * Returns null if the key is invalid or revoked.
 */
export async function validateApiKey(
  key: string,
): Promise<{ tenantId: TenantId | null; scope: "admin" | "tenant"; keyId: string } | null> {
  const db = getDb();
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");

  const result = await db.query(
    `UPDATE api_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, tenant_id, scope`,
    [keyHash],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    tenantId: (row.tenant_id as string) || null,
    scope: row.scope as "admin" | "tenant",
    keyId: row.id as string,
  };
}

// ── Audit Logging ──────────────────────────────────────────────

/** Write an entry to the audit log. */
export async function writeAuditLog(params: {
  tenantId?: TenantId;
  actor: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.tenantId || null,
      params.actor,
      params.action,
      params.resourceType || null,
      params.resourceId || null,
      params.details ? JSON.stringify(params.details) : null,
    ],
  );
}
