import { Pool, type PoolClient } from "pg";

export type PgPool = Pool;
export type PgClient = PoolClient;

export function createPool(connectionString: string): PgPool {
  return new Pool({ connectionString });
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
