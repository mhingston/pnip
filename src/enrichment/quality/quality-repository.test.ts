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
import { loadConfig } from "../../config/index.js";
import { createPool, closePool, type PgPool } from "../../database/pool.js";
import { closeKysely, type Database } from "../../database/kysely.js";
import {
  createDocumentRepository,
  type DocumentRepository,
} from "../../expansion/document-repository.js";
import {
  createSectionRepository,
  type SectionRepository,
} from "../../expansion/section-repository.js";
import {
  createChunkRepository,
  type ChunkRepository,
} from "../../chunking/chunk-repository.js";
import {
  createPromptRepository,
  type PromptRepository,
} from "../../prompts/prompt-repository.js";
import {
  createQualityRepository,
  type QualityRepository,
} from "./quality-repository.js";

const editionMigrationPath = fileURLToPath(
  new URL("../../database/migrations/003_create_editions.sql", import.meta.url),
);
const docMigrationPath = fileURLToPath(
  new URL("../../database/migrations/008_create_documents.sql", import.meta.url),
);
const sectionMigrationPath = fileURLToPath(
  new URL("../../database/migrations/009_create_document_sections.sql", import.meta.url),
);
const chunkMigrationPath = fileURLToPath(
  new URL("../../database/migrations/010_create_document_chunks.sql", import.meta.url),
);
const promptMigrationPath = fileURLToPath(
  new URL("../../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);
const qualityMigrationPath = fileURLToPath(
  new URL("../../database/migrations/015_create_quality_classifications.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("QualityRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let promptRepo: PromptRepository;
  let qualityRepo: QualityRepository;
  const schema = schemaName("quality_");
  let documentId: string;
  let sectionId: string;
  let promptId: string;

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
    const promptSql = await readFile(promptMigrationPath, "utf8");
    const qualitySql = await readFile(qualityMigrationPath, "utf8");

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
      await client.query(promptSql);
      await client.query(qualitySql);
      await client.query(partitionSql);
    } finally {
      client.release();
    }

    const kyselyPool = createPool(url);
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
    promptRepo = createPromptRepository(db);
    qualityRepo = createQualityRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-05-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/quality-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
    ]);
    sectionId = sections[0].id;

    const prompt = await promptRepo.createNewVersion({
      name: "quality",
      template: "t",
      purpose: "test",
    });
    promptId = prompt.id;
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
    await db.deleteFrom("quality_classifications").execute();
    await db.deleteFrom("document_chunks").execute();
  });

  it("replaces existing classification for a chunk (idempotent)", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "ql-chunk-1",
        documentId,
        sectionId,
        sequence: 0,
        text: "Body.",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 5,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    const chunkId = chunks[0].id;

    await qualityRepo.replaceForChunk({
      chunkId,
      documentId,
      label: "low",
      confidence: 0.3,
      reasoning: "poorly written",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
    });

    let row = await qualityRepo.getByChunkId(chunkId);
    expect(row?.label).toBe("low");

    await qualityRepo.replaceForChunk({
      chunkId,
      documentId,
      label: "high",
      confidence: 0.9,
      reasoning: "excellent",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
    });

    row = await qualityRepo.getByChunkId(chunkId);
    expect(row?.label).toBe("high");
    expect(row?.input_hash).toBe("h2");
  });

  it("getByDocumentId returns one row per chunk", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "ql-chunk-2",
        documentId,
        sectionId,
        sequence: 0,
        text: "a",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 1,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
      {
        id: "ql-chunk-3",
        documentId,
        sectionId,
        sequence: 1,
        text: "b",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 1,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);

    for (const c of chunks) {
      await qualityRepo.replaceForChunk({
        chunkId: c.id,
        documentId,
        label: "med",
        confidence: 0.5,
        reasoning: null,
        promptId,
        promptVersion: 1,
        model: "m",
        provider: "p",
        inputHash: "h",
      });
    }

    const all = await qualityRepo.getByDocumentId(documentId);
    expect(all).toHaveLength(2);
  });

  it("deleteByChunkId removes the classification", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "ql-chunk-4",
        documentId,
        sectionId,
        sequence: 0,
        text: "Body.",
        tokenCount: 1,
        startOffset: 0,
        endOffset: 5,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    const chunkId = chunks[0].id;

    await qualityRepo.replaceForChunk({
      chunkId,
      documentId,
      label: "high",
      confidence: 0.9,
      reasoning: null,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
    });
    expect(await qualityRepo.getByChunkId(chunkId)).toBeDefined();

    await qualityRepo.deleteByChunkId(chunkId);
    expect(await qualityRepo.getByChunkId(chunkId)).toBeUndefined();
  });
});
