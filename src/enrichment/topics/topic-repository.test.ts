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
  createTopicRepository,
  type TopicRepository,
} from "./topic-repository.js";

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
const topicMigrationPath = fileURLToPath(
  new URL("../../database/migrations/014_create_topics.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("TopicRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let promptRepo: PromptRepository;
  let topicRepo: TopicRepository;
  const schema = schemaName("topic_");
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
    const topicSql = await readFile(topicMigrationPath, "utf8");

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
      await client.query(topicSql);
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
    topicRepo = createTopicRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-04-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/topic-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
    ]);
    sectionId = sections[0].id;

    const prompt = await promptRepo.createNewVersion({
      name: "topics",
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
    await db.deleteFrom("topic_assignments").execute();
    await db.deleteFrom("topics").execute();
    await db.deleteFrom("document_chunks").execute();
  });

  it("replaces topics for a chunk (idempotent)", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "tp-chunk-1",
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

    await topicRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      topics: [{ topic: "ai", confidence: 0.9, relevance: 0.85 }],
    });

    let byChunk = await topicRepo.getByChunkId(chunkId);
    expect(byChunk).toHaveLength(1);

    await topicRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      topics: [
        { topic: "ai", confidence: 0.95, relevance: 0.9 },
        { topic: "tech", confidence: 0.7, relevance: 0.6 },
      ],
    });

    byChunk = await topicRepo.getByChunkId(chunkId);
    expect(byChunk).toHaveLength(2);
    expect(byChunk[0].confidence).toBe(0.95);
  });

  it("createBatch creates one topic_assignment per topic", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "tp-chunk-2",
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

    const { topics, assignments } = await topicRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      topics: [
        { topic: "ai", confidence: 0.9, relevance: 0.85 },
        { topic: "tech", confidence: 0.7, relevance: 0.6 },
      ],
    });

    expect(topics).toHaveLength(2);
    expect(assignments).toHaveLength(2);
    for (const a of assignments) {
      expect(a.chunk_id).toBe(chunkId);
      const linked = topics.find((t) => t.id === a.topic_id);
      expect(linked).toBeDefined();
    }
  });

  it("deleteByChunkId cascades to topic_assignments", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "tp-chunk-3",
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

    const { topics } = await topicRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      topics: [{ topic: "ai", confidence: 0.9, relevance: 0.85 }],
    });

    await topicRepo.deleteByChunkId(chunkId);
    expect(await topicRepo.getByChunkId(chunkId)).toHaveLength(0);

    const remaining = await db
      .selectFrom("topic_assignments")
      .selectAll()
      .where("topic_id", "=", topics[0].id)
      .execute();
    expect(remaining).toHaveLength(0);
  });
});
