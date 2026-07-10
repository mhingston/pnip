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
import { getActivePartitions } from "./active-partitions.js";
import { PARTITION_MASTER } from "../discovery/partition-resolver.js";

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

describe("getActivePartitions", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("active_parts_test_");

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
    editionCounter = 0;
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  let editionCounter = 0;
  async function insertEdition(): Promise<string> {
    editionCounter += 1;
    const id = randomUUID();
    const date = `2026-07-${String(7 + editionCounter).padStart(2, "0")}`;
    await pool.query(
      `INSERT INTO ${schema}.editions (id, publication_date, status)
       VALUES ($1, $2::date, 'building')`,
      [id, date],
    );
    return id;
  }

  async function insertDocuments(
    editionId: string,
    partitionKey: string,
    n: number,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO ${schema}.documents (edition_id, source_type, source_url, partition_key)
         VALUES ($1, 'article', $2, $3)`,
        [editionId, `https://example.com/${partitionKey}/${i}`, partitionKey],
      );
    }
  }

  it("with empty config returns only the master partition (with documentCount 0)", async () => {
    const editionId = await insertEdition();
    const result = await getActivePartitions({
      db,
      editionId,
      config: {},
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 0, withPodcast: false },
    ]);
  });

  it("master documentCount reflects every document in the edition", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 19);
    await insertDocuments(editionId, "youtube", 7);
    const result = await getActivePartitions({ db, editionId, config: {} });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 26, withPodcast: false },
    ]);
  });

  it("configured partition with 0 docs is not in the result", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 3);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 3, withPodcast: false },
    ]);
  });

  it("configured partition below min_articles is not in the result", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "youtube", 4);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 14, withPodcast: false },
    ]);
  });

  it("configured partition exactly at min_articles is in the result", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "youtube", 5);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 15, withPodcast: false },
      { partitionKey: "youtube", documentCount: 5, withPodcast: false },
    ]);
  });

  it("configured partition above min_articles is in the result with correct count", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 12);
    await insertDocuments(editionId, "youtube", 7);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 19, withPodcast: false },
      { partitionKey: "youtube", documentCount: 7, withPodcast: false },
    ]);
  });

  it("with_podcast flag propagates from config to result entry", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "youtube", 7);
    const result = await getActivePartitions({
      db,
      editionId,
      config: {
        youtube: { min_articles: 5, enabled: true, with_podcast: true },
      },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 17, withPodcast: false },
      { partitionKey: "youtube", documentCount: 7, withPodcast: true },
    ]);
  });

  it("enabled: false excludes the partition regardless of count", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "youtube", 7);
    const result = await getActivePartitions({
      db,
      editionId,
      config: {
        youtube: { min_articles: 1, enabled: false },
      },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 17, withPodcast: false },
    ]);
  });

  it("default min_articles is 5 when the field is omitted from the config", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "youtube", 5);
    await insertDocuments(editionId, "blogs", 4);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { enabled: true }, blogs: { enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 19, withPodcast: false },
      { partitionKey: "youtube", documentCount: 5, withPodcast: false },
    ]);
  });

  it("multiple configured partitions with mixed states yield the right set", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 19);
    await insertDocuments(editionId, "youtube", 7);
    await insertDocuments(editionId, "blogs", 5);
    await insertDocuments(editionId, "reddit", 1);
    const result = await getActivePartitions({
      db,
      editionId,
      config: {
        youtube: { min_articles: 5, enabled: true, with_podcast: true },
        blogs: { min_articles: 3, enabled: true },
        reddit: { min_articles: 5, enabled: true },
        disabled_one: { min_articles: 1, enabled: false },
      },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 32, withPodcast: false },
      { partitionKey: "youtube", documentCount: 7, withPodcast: true },
      { partitionKey: "blogs", documentCount: 5, withPodcast: false },
    ]);
  });

  it("does not include partitions that exist in documents but not in config", async () => {
    const editionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(editionId, "stray", 8);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 18, withPodcast: false },
    ]);
  });

  it("does not include partitions from other editions", async () => {
    const editionId = await insertEdition();
    const otherEditionId = await insertEdition();
    await insertDocuments(editionId, PARTITION_MASTER, 10);
    await insertDocuments(otherEditionId, "youtube", 8);
    const result = await getActivePartitions({
      db,
      editionId,
      config: { youtube: { min_articles: 5, enabled: true } },
    });
    expect(result).toEqual([
      { partitionKey: PARTITION_MASTER, documentCount: 10, withPodcast: false },
    ]);
  });
});
