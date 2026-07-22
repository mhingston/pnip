import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withTransaction, type PgPool } from "./pool.js";

const MIGRATIONS_TABLE = "_migrations";
const DEFAULT_DIR = fileURLToPath(new URL("migrations/", import.meta.url));
const NON_TRANSACTIONAL_MARKER = /^\s*--\s*pnip:\s*non-transactional\s*$/im;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  readonly filename: string;
  constructor(filename: string, cause: unknown) {
    super(`Migration "${filename}" failed`, { cause });
    this.name = "MigrationError";
    this.filename = filename;
  }
}

async function ensureMigrationsTable(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

export { listMigrationFiles };

export function isNonTransactionalMigration(sql: string): boolean {
  return NON_TRANSACTIONAL_MARKER.test(sql);
}

export async function runMigrations(
  pool: PgPool,
  opts?: { directory?: string },
): Promise<MigrationResult> {
  const directory = opts?.directory ?? DEFAULT_DIR;
  await ensureMigrationsTable(pool);

  const existing = await pool.query(
    `SELECT filename FROM ${MIGRATIONS_TABLE}`,
  );
  const appliedSet = new Set(
    existing.rows.map((row: { filename: string }) => row.filename),
  );

  const files = await listMigrationFiles(directory);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    if (appliedSet.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = await readFile(`${directory}/${filename}`, "utf8");
    try {
      if (isNonTransactionalMigration(sql)) {
        // PostgreSQL's CREATE INDEX CONCURRENTLY cannot run inside a
        // transaction. The migration is still recorded only after the DDL
        // succeeds; IF NOT EXISTS makes a retry safe if recording is
        // interrupted after the index was built.
        await pool.query(sql);
        await pool.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
          [filename],
        );
      } else {
        await withTransaction(pool, async (client) => {
          await client.query(sql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
            [filename],
          );
        });
      }
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(filename, err);
    }
    applied.push(filename);
  }

  return { applied, skipped };
}

export async function getAppliedMigrations(pool: PgPool): Promise<string[]> {
  const exists = await pool.query("SELECT to_regclass('_migrations') AS exists");
  if (!exists.rows[0].exists) return [];
  const r = await pool.query(
    `SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename ASC`,
  );
  return r.rows.map((row: { filename: string }) => row.filename);
}
