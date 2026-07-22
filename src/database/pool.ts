import { Pool, type PoolClient } from "pg";

export type PgPool = Pool;
export type PgClient = PoolClient;

export interface PgPoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

const DEFAULT_POOL_OPTIONS: Required<PgPoolOptions> = {
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

export function createPool(
  connectionString: string,
  options?: PgPoolOptions,
): PgPool {
  const pool = new Pool({
    connectionString,
    ...DEFAULT_POOL_OPTIONS,
    ...options,
  });
  // pg emits client errors on the pool itself. Without a listener, a
  // transient server/network disconnect can become an uncaught process error
  // and terminate a queue drain instead of allowing the pool to replace the
  // failed client.
  pool.on("error", (err) => {
    console.error(`[pnip] PostgreSQL pool client error: ${err.message}`);
  });
  return pool;
}

export async function withTransaction<T>(
  pool: PgPool,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // rollback failure must not mask the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(pool: PgPool): Promise<void> {
  await pool.end();
}
