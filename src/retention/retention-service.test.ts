import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, CompiledQuery } from "kysely";
import { loadConfig } from "../config/index.js";
import { createPool, closePool, type PgPool } from "../database/pool.js";
import { closeKysely, type Database } from "../database/kysely.js";
import { previewRetention, purgeExpiredData } from "./retention-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("retention-service", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("retention_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set for integration tests");
    pool = createPool(url);
    kyselyPool = createPool(url);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      const migrationsDir = fileURLToPath(
        new URL("../database/migrations/", import.meta.url),
      );
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files) {
        await client.query(await readFile(`${migrationsDir}/${file}`, "utf8"));
      }
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
    await pool.query(
      `TRUNCATE TABLE ${schema}.processing_jobs, ${schema}.document_lineage, ${schema}.editions RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  it("purges edition-linked content, embeddings, lineage, and old jobs while retaining recent editions", async () => {
    const oldCreatedAt = new Date(Date.now() - 31 * DAY_MS);
    const oldEdition = await db
      .insertInto("editions")
      .values({ publication_date: oldCreatedAt, created_at: oldCreatedAt })
      .returning("id")
      .executeTakeFirstOrThrow();
    const recentEdition = await db
      .insertInto("editions")
      .values({ publication_date: new Date(), created_at: new Date() })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("discovery_events")
      .values({
        edition_id: oldEdition.id,
        miniflux_entry_id: "1001",
        feed_id: "2001",
        url: "https://old.example/discovered",
        partition_key: "master",
      })
      .execute();

    const oldDocument = await db
      .insertInto("documents")
      .values({
        edition_id: oldEdition.id,
        source_type: "article",
        source_url: "https://old.example/article",
        partition_key: "master",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const section = await db
      .insertInto("document_sections")
      .values({
        document_id: oldDocument.id,
        section_order: 0,
        section_type: "paragraph",
        content_text: "old content",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("document_chunks")
      .values({
        id: "00000000000000000000000000000001",
        document_id: oldDocument.id,
        section_id: section.id,
        chunk_sequence: 0,
        content_text: "old chunk",
        token_count: 2,
        start_offset: 0,
        end_offset: 9,
        paragraph_start: 0,
        paragraph_end: 0,
      })
      .execute();
    const vector = `[${Array(384).fill("0").join(",")}]`;
    await db
      .insertInto("embeddings")
      .values({
        chunk_id: "00000000000000000000000000000001",
        vector,
        model: "fake",
        provider: "fake",
        input_hash: "old-hash",
      })
      .execute();
    await db
      .insertInto("document_lineage")
      .values({
        source_type: "document",
        source_id: oldDocument.id,
        target_type: "chunk",
        target_id: "00000000-0000-0000-0000-000000000001",
        relation: "contains",
      })
      .execute();
    await db
      .insertInto("processing_jobs")
      .values({
        job_type: "old-job",
        edition_id: oldEdition.id,
        created_at: oldCreatedAt,
        updated_at: oldCreatedAt,
      })
      .execute();
    await db
      .insertInto("processing_jobs")
      .values({ job_type: "recent-job", edition_id: recentEdition.id })
      .execute();

    const options = { olderThanMs: 30 * DAY_MS, limit: 100 };
    await expect(previewRetention(db, options)).resolves.toEqual({
      editions: 1,
      jobs: 1,
      lineage: 1,
    });
    await expect(purgeExpiredData(db, options)).resolves.toEqual({
      editions: 1,
      jobs: 1,
      lineage: 1,
    });

    expect(await db.selectFrom("editions").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("documents").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("embeddings").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("document_lineage").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("discovery_events").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("processing_jobs").select("id").execute()).toHaveLength(1);
  });
});
