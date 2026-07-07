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
import {
  closeKysely,
  type Database,
} from "../database/kysely.js";
import { getEditionMetrics } from "./edition-metrics.js";

const migrationSqlPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("getEditionMetrics", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("edition_metrics_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const sqlText = await readMigrationSql();
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
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

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.editions`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  let dateCounter = 0;

  async function insertEdition(opts: {
    status: string;
    createdAt?: Date;
    publishedAt?: Date | null;
  }): Promise<void> {
    const id = randomUUID();
    const createdAt = opts.createdAt ?? new Date();
    const publishedAt =
      opts.publishedAt === undefined ? null : opts.publishedAt;
    dateCounter += 1;
    const publicationDate = `2026-0${1 + (dateCounter % 9)}-${10 + (dateCounter % 18)}`;
    await pool.query(
      `INSERT INTO ${schema}.editions (id, publication_date, status, created_at, published_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        publicationDate,
        opts.status,
        createdAt,
        publishedAt,
      ],
    );
  }

  it("returns zero counts and null fields on an empty table", async () => {
    const m = await getEditionMetrics(db);
    expect(m.total).toBe(0);
    expect(m.byStatus).toEqual({});
    expect(m.publishedCount).toBe(0);
    expect(m.avgPublicationDurationMs).toBeNull();
    expect(m.lastPublishedAt).toBeNull();
    expect(m.oldestBuildingAgeMs).toBeNull();
  });

  it("reports publishedCount, lastPublishedAt, and avg publication duration for published editions", async () => {
    const createdA = new Date(Date.now() - 60 * 60 * 1000);
    const publishedA = new Date(Date.now() - 30 * 60 * 1000);
    const createdB = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const publishedB = new Date(Date.now() - 60 * 60 * 1000);
    await insertEdition({
      status: "published",
      createdAt: createdA,
      publishedAt: publishedA,
    });
    await insertEdition({
      status: "published",
      createdAt: createdB,
      publishedAt: publishedB,
    });

    const m = await getEditionMetrics(db);
    expect(m.total).toBe(2);
    expect(m.byStatus.published).toBe(2);
    expect(m.publishedCount).toBe(2);
    expect(m.lastPublishedAt).not.toBeNull();
    expect(m.lastPublishedAt!.getTime()).toBeGreaterThanOrEqual(
      publishedA.getTime() - 1000,
    );
    expect(m.avgPublicationDurationMs).not.toBeNull();
    expect(m.avgPublicationDurationMs!).toBeGreaterThan(0);
    expect(m.oldestBuildingAgeMs).toBeNull();
  });

  it("byStatus reflects a mixed table and total sums every status", async () => {
    await insertEdition({ status: "building" });
    await insertEdition({ status: "ready" });
    await insertEdition({ status: "publishing" });
    await insertEdition({ status: "failed" });
    await insertEdition({
      status: "published",
      publishedAt: new Date(),
    });

    const m = await getEditionMetrics(db);
    expect(m.total).toBe(5);
    expect(m.byStatus).toEqual({
      building: 1,
      ready: 1,
      publishing: 1,
      failed: 1,
      published: 1,
    });
    expect(m.publishedCount).toBe(1);
  });

  it("oldestBuildingAgeMs reflects the oldest building edition and is null when none are building", async () => {
    await insertEdition({
      status: "building",
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await insertEdition({
      status: "building",
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    const m = await getEditionMetrics(db);
    expect(m.oldestBuildingAgeMs).not.toBeNull();
    expect(m.oldestBuildingAgeMs!).toBeGreaterThan(9 * 60 * 1000);

    await pool.query(`TRUNCATE TABLE ${schema}.editions`);
    await insertEdition({
      status: "published",
      publishedAt: new Date(),
    });
    const afterPublish = await getEditionMetrics(db);
    expect(afterPublish.oldestBuildingAgeMs).toBeNull();
  });
});
