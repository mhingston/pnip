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
  createDocumentRepository,
  type DocumentRepository,
} from "./document-repository.js";

const docMigrationPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);
const editionMigrationPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("DocumentRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: DocumentRepository;
  const schema = schemaName("doc_");
  let editionId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const docSql = await readFile(docMigrationPath, "utf8");
    const editionSql = await readFile(editionMigrationPath, "utf8");

    const partitionSql = `
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'editions') THEN
          ALTER TABLE editions ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'discovery_events') THEN
          ALTER TABLE discovery_events ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'documents') THEN
          ALTER TABLE documents ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
      END $$;
    `;

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(partitionSql);
    } finally {
      client.release();
    }

    kyselyPool = createPool(url);
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
    repo = createDocumentRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-01-01") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;
  });

  afterAll(async () => {
    await closeKysely(db);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    await closePool(pool);
  });

  beforeEach(async () => {
    await db.deleteFrom("documents").execute();
  });

  it("creates a document and returns it", async () => {
    const doc = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/article",
      title: "Test Article",
    });

    expect(doc.id).toBeDefined();
    expect(doc.source_type).toBe("article");
    expect(doc.source_url).toBe("https://example.com/article");
    expect(doc.title).toBe("Test Article");
    expect(doc.language).toBe("en");
  });

  it("getById returns undefined for missing document", async () => {
    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("getById returns the document", async () => {
    const created = await repo.create({
      editionId,
      sourceType: "youtube",
      sourceUrl: "https://youtube.com/watch?v=xyz",
    });
    const found = await repo.getById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("getByEdition returns documents for the edition", async () => {
    const d1 = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/a",
    });
    const d2 = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/b",
    });

    const docs = await repo.getByEdition(editionId);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it("getByEditionAndUrl finds existing document by URL", async () => {
    const created = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/unique",
    });
    const found = await repo.getByEditionAndUrl(editionId, "https://example.com/unique");
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("getByEditionAndUrl returns undefined for unknown URL", async () => {
    expect(await repo.getByEditionAndUrl(editionId, "https://example.com/unknown")).toBeUndefined();
  });

  it("respects UNIQUE(edition_id, source_url)", async () => {
    await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/dup",
    });
    await expect(
      repo.create({
        editionId,
        sourceType: "article",
        sourceUrl: "https://example.com/dup",
      }),
    ).rejects.toThrow();
  });

  it("stores optional fields", async () => {
    const doc = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/full",
      title: "Full Article",
      canonicalUrl: "https://example.com/canonical",
      authors: ["Alice", "Bob"],
      publishedAt: new Date("2026-06-01"),
      language: "fr",
      contentMarkdown: "# Hello",
      contentText: "Hello",
      metadata: { key: "val" },
    });

    expect(doc.title).toBe("Full Article");
    expect(doc.canonical_url).toBe("https://example.com/canonical");
    expect(doc.language).toBe("fr");
    expect(doc.content_markdown).toBe("# Hello");
    expect(doc.content_text).toBe("Hello");
  });
});
