import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, CompiledQuery } from "kysely";
import { loadConfig } from "../config/index.js";
import { createPool, closePool, type PgPool } from "../database/pool.js";
import { closeKysely, type Database } from "../database/kysely.js";
import {
  createSourceTrustRepository,
  type SourceTrustRow,
} from "./source-trust-repository.js";

const migrationSqlPath =
  "../database/migrations/025_create_source_trust.sql";

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("SourceTrustRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("strust_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set");
    pool = createPool(url);
    const kyselyPool = createPool(url);

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      const sqlText = await readMigrationSql(migrationSqlPath);
      await client.query(sqlText);
    } finally {
      client.release();
    }

    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: kyselyPool,
        onReserveConnection: async (conn) => {
          await conn.executeQuery(
            CompiledQuery.raw(`SET search_path TO ${schema}, public`),
          );
        },
      }),
    });
  });

  afterAll(async () => {
    if (db) await closeKysely(db);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    await closePool(pool);
  });

  beforeEach(async () => {
    await db.deleteFrom("source_trust").execute();
  });

  it("set + get round-trips a row with tier defaulting to 3 when unspecified", async () => {
    const repo = createSourceTrustRepository(db);
    const row = await repo.set("theverge.com", 2, "core tech source");
    expect(row.source_identity).toBe("theverge.com");
    expect(row.tier).toBe(2);
    expect(row.notes).toBe("core tech source");
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);

    const got = await repo.get("theverge.com");
    expect(got).toBeDefined();
    expect(got!.tier).toBe(2);
    expect(got!.notes).toBe("core tech source");
  });

  it("set is an upsert: a second call updates tier, notes, and updated_at", async () => {
    const repo = createSourceTrustRepository(db);
    const first = await repo.set("reddit.com/r/machinelearning", 3, null);
    expect(first.tier).toBe(3);
    expect(first.notes).toBeNull();
    const firstUpdated = first.updated_at;

    await new Promise((r) => setTimeout(r, 10));

    const second = await repo.set("reddit.com/r/machinelearning", 1, "top ML");
    expect(second.tier).toBe(1);
    expect(second.notes).toBe("top ML");
    expect(second.updated_at.getTime()).toBeGreaterThanOrEqual(
      firstUpdated.getTime(),
    );
    expect(second.source_identity).toBe(first.source_identity);

    const all = await repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.tier).toBe(1);
  });

  it("getAll returns all rows ordered by source_identity ascending", async () => {
    const repo = createSourceTrustRepository(db);
    await repo.set("zeta.com", 4);
    await repo.set("alpha.com", 2);
    await repo.set("mid.com", 3);
    const all = await repo.getAll();
    expect(all.map((r) => r.source_identity)).toEqual([
      "alpha.com",
      "mid.com",
      "zeta.com",
    ]);
  });

  it("delete removes a row and get returns undefined afterward", async () => {
    const repo = createSourceTrustRepository(db);
    await repo.set("gone.com", 5);
    expect(await repo.get("gone.com")).toBeDefined();
    await repo.delete("gone.com");
    expect(await repo.get("gone.com")).toBeUndefined();
  });

  it("rejects a tier outside the 1-5 CHECK constraint (0 and 6)", async () => {
    const repo = createSourceTrustRepository(db);
    await expect(repo.set("low.com", 0)).rejects.toThrow();
    await expect(repo.set("high.com", 6)).rejects.toThrow();
    expect(await repo.get("low.com")).toBeUndefined();
    expect(await repo.get("high.com")).toBeUndefined();
  });
});
