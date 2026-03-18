/**
 * PostgreSQL connection pool for the control plane.
 *
 * Provides a singleton pool that all control plane modules share.
 * Connection string is read from the DATABASE_URL environment variable.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export type ControlPlaneDbConfig = {
  /** PostgreSQL connection string (e.g., postgres://user:pass@host:5432/dbname). */
  connectionString: string;
  /** Maximum number of clients in the pool. Default: 20. */
  maxPoolSize?: number;
  /** Idle timeout in milliseconds. Default: 30000. */
  idleTimeoutMs?: number;
  /** Connection timeout in milliseconds. Default: 5000. */
  connectionTimeoutMs?: number;
};

/**
 * Initialize the control plane database connection pool.
 * Must be called once at control plane startup.
 */
export function initDb(config: ControlPlaneDbConfig): pg.Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxPoolSize ?? 20,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
  });

  // Log connection errors without crashing the process.
  pool.on("error", (err) => {
    console.error("[control-plane/db] Unexpected pool error:", err.message);
  });

  return pool;
}

/**
 * Get the active database pool.
 * Throws if `initDb()` has not been called.
 */
export function getDb(): pg.Pool {
  if (!pool) {
    throw new Error("[control-plane/db] Database pool not initialized. Call initDb() first.");
  }
  return pool;
}

/**
 * Close the database pool gracefully.
 * Called during control plane shutdown.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run a health check against the database.
 * Returns true if the database is reachable.
 */
export async function checkDbHealth(): Promise<boolean> {
  try {
    const db = getDb();
    const result = await db.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
