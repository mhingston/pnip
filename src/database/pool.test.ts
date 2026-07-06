import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import {
  createPool,
  withTransaction,
  closePool,
  type PgPool,
} from "./pool.js";

describe("pool / withTransaction", () => {
  let pool: PgPool;
  const schema = "pool_test_" + randomUUID().replace(/-/g, "");
  const table = `${schema}.probe`;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, val text)`);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${table}`);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await closePool(pool);
    }
  });

  it("commits on success: row inserted inside fn persists afterwards", async () => {
    await withTransaction(pool, async (client) => {
      await client.query(`INSERT INTO ${table} (id, val) VALUES ($1, $2)`, [
        1,
        "a",
      ]);
    });

    const r = await pool.query(`SELECT * FROM ${table}`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ id: 1, val: "a" });
  });

  it("rolls back on error: nothing persists when fn throws", async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query(`INSERT INTO ${table} (id, val) VALUES ($1, $2)`, [
          2,
          "b",
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    const r = await pool.query(`SELECT * FROM ${table}`);
    expect(r.rows).toHaveLength(0);
  });

  it("rethrows the original error instance", async () => {
    const err = new Error("specific");
    await expect(
      withTransaction(pool, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("releases the client on error so the pool stays usable", async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("SELECT 1");
        throw new Error("x");
      }),
    ).rejects.toThrow();

    const r = await pool.query("SELECT 1 AS ok");
    expect(r.rows[0].ok).toBe(1);
  });
});
