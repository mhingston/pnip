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
} from "../expansion/document-repository.js";
import {
  createSectionRepository,
  type SectionRepository,
} from "../expansion/section-repository.js";
import {
  createChunkRepository,
  type ChunkRepository,
} from "./chunk-repository.js";

const editionMigrationPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const docMigrationPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);
const sectionMigrationPath = fileURLToPath(
  new URL("../database/migrations/009_create_document_sections.sql", import.meta.url),
);
const chunkMigrationPath = fileURLToPath(
  new URL("../database/migrations/010_create_document_chunks.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("ChunkRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  const schema = schemaName("chunk_");
  let documentId: string;
  let sectionId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const editionSql = await readFile(editionMigrationPath, "utf8");
    const docSql = await readFile(docMigrationPath, "utf8");
    const sectionSql = await readFile(sectionMigrationPath, "utf8");
    const chunkSql = await readFile(chunkMigrationPath, "utf8");

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
      await client.query(sectionSql);
      await client.query(chunkSql);
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
    docRepo = createDocumentRepository(db);
    sectionRepo = createSectionRepository(db);
    chunkRepo = createChunkRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-01-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/chunk-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Test Title" },
      { documentId, order: 1, type: "paragraph", contentText: "Paragraph one.\n\nParagraph two.\n\nParagraph three." },
    ]);
    sectionId = sections[0].id;
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
    await db.deleteFrom("document_chunks").execute();
  });

  it("creates chunks in batch", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "chunk-1",
        documentId,
        sectionId,
        sequence: 0,
        text: "Test Title",
        tokenCount: 3,
        startOffset: 0,
        endOffset: 10,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("chunk-1");
    expect(chunks[0].document_id).toBe(documentId);
    expect(chunks[0].section_id).toBe(sectionId);
    expect(chunks[0].chunk_sequence).toBe(0);
    expect(chunks[0].content_text).toBe("Test Title");
    expect(chunks[0].token_count).toBe(3);
    expect(chunks[0].start_offset).toBe(0);
    expect(chunks[0].end_offset).toBe(10);
    expect(chunks[0].paragraph_start).toBe(0);
    expect(chunks[0].paragraph_end).toBe(0);
    expect(chunks[0].timestamp_start).toBeNull();
    expect(chunks[0].timestamp_end).toBeNull();
  });

  it("creates chunks with optional timestamps", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "chunk-ts",
        documentId,
        sectionId,
        sequence: 0,
        text: "Transcript chunk",
        tokenCount: 5,
        startOffset: 0,
        endOffset: 16,
        paragraphStart: 0,
        paragraphEnd: 0,
        timestampStart: 10.5,
        timestampEnd: 25.3,
      },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].timestamp_start).toBe(10.5);
    expect(chunks[0].timestamp_end).toBe(25.3);
  });

  it("getByDocumentId returns chunks ordered by chunk_sequence", async () => {
    await chunkRepo.createBatch([
      {
        id: "c-b",
        documentId,
        sectionId,
        sequence: 1,
        text: "Second",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 6,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
      {
        id: "c-a",
        documentId,
        sectionId,
        sequence: 0,
        text: "First",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 5,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    const chunks = await chunkRepo.getByDocumentId(documentId);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].id).toBe("c-a");
    expect(chunks[1].id).toBe("c-b");
  });

  it("getBySectionId returns chunks for a section", async () => {
    await chunkRepo.createBatch([
      {
        id: "cs-1",
        documentId,
        sectionId,
        sequence: 0,
        text: "A",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 1,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    const chunks = await chunkRepo.getBySectionId(sectionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("cs-1");
  });

  it("getByDocumentId returns empty array for unknown document", async () => {
    const chunks = await chunkRepo.getByDocumentId("00000000-0000-0000-0000-000000000000");
    expect(chunks).toEqual([]);
  });

  it("deleteByDocumentId removes all chunks for a document", async () => {
    await chunkRepo.createBatch([
      {
        id: "del-1",
        documentId,
        sectionId,
        sequence: 0,
        text: "A",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 1,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    await chunkRepo.deleteByDocumentId(documentId);
    const chunks = await chunkRepo.getByDocumentId(documentId);
    expect(chunks).toEqual([]);
  });

  it("respects UNIQUE(document_id, section_id, chunk_sequence)", async () => {
    await chunkRepo.createBatch([
      {
        id: "uniq-1",
        documentId,
        sectionId,
        sequence: 0,
        text: "First",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 5,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    await expect(
      chunkRepo.createBatch([
        {
          id: "uniq-2",
          documentId,
          sectionId,
          sequence: 0,
          text: "Duplicate",
          tokenCount: 2,
          startOffset: 0,
          endOffset: 9,
          paragraphStart: 0,
          paragraphEnd: 0,
        },
      ]),
    ).rejects.toThrow();
  });

  it("createBatch returns empty array for empty input", async () => {
    const result = await chunkRepo.createBatch([]);
    expect(result).toEqual([]);
  });
});
