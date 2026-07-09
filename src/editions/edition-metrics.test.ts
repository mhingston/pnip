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
import {
  getEditionMetrics,
  getPartitionMetrics,
} from "./edition-metrics.js";

const editionsSqlPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const documentsSqlPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);

function readSql(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const PARTITION_ALTER_SQL = `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'editions') THEN
      ALTER TABLE editions ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'documents') THEN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
    END IF;
  END $$;
`;

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

    const editionsSql = await readSql(editionsSqlPath);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionsSql);
      await client.query(PARTITION_ALTER_SQL);
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
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
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

    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
    await insertEdition({
      status: "published",
      publishedAt: new Date(),
    });
    const afterPublish = await getEditionMetrics(db);
    expect(afterPublish.oldestBuildingAgeMs).toBeNull();
  });
});

describe("getPartitionMetrics", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("partition_metrics_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const editionsSql = await readSql(editionsSqlPath);
    const documentsSql = await readSql(documentsSqlPath);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionsSql);
      await client.query(documentsSql);
      await client.query(PARTITION_ALTER_SQL);
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
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function insertEdition(opts: {
    publicationDate: string;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ${schema}.editions (id, publication_date, status)
       VALUES ($1, $2::date, 'building')`,
      [id, opts.publicationDate],
    );
    return id;
  }

  async function insertDocument(opts: {
    editionId: string;
    partitionKey: string;
    url: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${schema}.documents (edition_id, source_type, source_url, partition_key)
       VALUES ($1, 'article', $2, $3)`,
      [opts.editionId, opts.url, opts.partitionKey],
    );
  }

  it("returns empty arrays on an empty database", async () => {
    const m = await getPartitionMetrics(db);
    expect(m.byPartition).toEqual([]);
    expect(m.perDayLast7Days).toEqual([]);
  });

  it("one edition, 5 master documents: one row, latest_document_count = 5", async () => {
    const edId = await insertEdition({ publicationDate: "2026-07-08" });
    for (let i = 0; i < 5; i++) {
      await insertDocument({
        editionId: edId,
        partitionKey: "master",
        url: `https://example.com/${i}`,
      });
    }

    const m = await getPartitionMetrics(db);
    expect(m.byPartition.length).toBe(1);
    const master = m.byPartition[0]!;
    expect(master.partition_key).toBe("master");
    expect(master.total_documents).toBe(5);
    expect(master.distinct_days).toBe(1);
    expect(master.latest_edition_date).toBe("2026-07-08");
    expect(master.latest_document_count).toBe(5);
    expect(m.perDayLast7Days.length).toBe(1);
    expect(m.perDayLast7Days[0]).toEqual({
      edition_date: "2026-07-08",
      partition_key: "master",
      document_count: 5,
    });
  });

  it("three editions on three days with mixed partitions: correct totals and distinct_days", async () => {
    const edA = await insertEdition({ publicationDate: "2026-07-06" });
    const edB = await insertEdition({ publicationDate: "2026-07-07" });
    const edC = await insertEdition({ publicationDate: "2026-07-08" });

    for (let i = 0; i < 3; i++) {
      await insertDocument({
        editionId: edA,
        partitionKey: "master",
        url: `https://example.com/a/${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertDocument({
        editionId: edB,
        partitionKey: "master",
        url: `https://example.com/b/${i}`,
      });
      await insertDocument({
        editionId: edB,
        partitionKey: "youtube",
        url: `https://example.com/b/yt/${i}`,
      });
    }
    await insertDocument({
      editionId: edC,
      partitionKey: "youtube",
      url: "https://example.com/c/yt/0",
    });
    await insertDocument({
      editionId: edC,
      partitionKey: "blogs",
      url: "https://example.com/c/blogs/0",
    });

    const m = await getPartitionMetrics(db);
    const byKey = new Map(m.byPartition.map((e) => [e.partition_key, e]));
    expect(byKey.size).toBe(3);
    const master = byKey.get("master")!;
    expect(master.total_documents).toBe(5);
    expect(master.distinct_days).toBe(2);
    expect(master.latest_edition_date).toBe("2026-07-07");
    expect(master.latest_document_count).toBe(2);
    const youtube = byKey.get("youtube")!;
    expect(youtube.total_documents).toBe(3);
    expect(youtube.distinct_days).toBe(2);
    expect(youtube.latest_edition_date).toBe("2026-07-08");
    expect(youtube.latest_document_count).toBe(1);
    const blogs = byKey.get("blogs")!;
    expect(blogs.total_documents).toBe(1);
    expect(blogs.distinct_days).toBe(1);
    expect(blogs.latest_edition_date).toBe("2026-07-08");
    expect(blogs.latest_document_count).toBe(1);
  });

  it("partition with no documents does not appear in the output", async () => {
    const edId = await insertEdition({ publicationDate: "2026-07-08" });
    for (let i = 0; i < 2; i++) {
      await insertDocument({
        editionId: edId,
        partitionKey: "master",
        url: `https://example.com/${i}`,
      });
    }

    const m = await getPartitionMetrics(db);
    expect(m.byPartition.length).toBe(1);
    expect(m.byPartition[0]!.partition_key).toBe("master");
  });

  it("perDayLast7Days excludes editions older than 7 days from now", async () => {
    const today = new Date();
    const fmt = (d: Date): string => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    };
    const todayStr = fmt(today);
    const oldDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldStr = fmt(oldDate);

    const edToday = await insertEdition({ publicationDate: todayStr });
    const edOld = await insertEdition({ publicationDate: oldStr });
    await insertDocument({
      editionId: edToday,
      partitionKey: "master",
      url: "https://example.com/today",
    });
    await insertDocument({
      editionId: edOld,
      partitionKey: "master",
      url: "https://example.com/old",
    });

    const m = await getPartitionMetrics(db);
    expect(m.byPartition.length).toBe(1);
    expect(m.byPartition[0]!.total_documents).toBe(2);
    const dayDates = m.perDayLast7Days.map((d) => d.edition_date);
    expect(dayDates).toContain(todayStr);
    expect(dayDates).not.toContain(oldStr);
  });
});