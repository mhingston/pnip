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
  createEntityRepository,
  type EntityRepository,
} from "./entity-repository.js";

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
const entityMigrationPath = fileURLToPath(
  new URL("../../database/migrations/013_create_entities.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EntityRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let promptRepo: PromptRepository;
  let entityRepo: EntityRepository;
  const schema = schemaName("entity_");
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
    const entitySql = await readFile(entityMigrationPath, "utf8");

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
      await client.query(entitySql);
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
    entityRepo = createEntityRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-03-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/entity-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
    ]);
    sectionId = sections[0].id;

    const prompt = await promptRepo.createNewVersion({
      name: "entities",
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
    await db.deleteFrom("entity_mentions").execute();
    await db.deleteFrom("entities").execute();
    await db.deleteFrom("document_chunks").execute();
  });

  it("replaces existing entities for a chunk (idempotent)", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "en-chunk-1",
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

    await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      entities: [
        { name: "Apple Inc.", entityType: "organization", mentionText: "Apple" },
      ],
    });

    let byChunk = await entityRepo.getByChunkId(chunkId);
    expect(byChunk).toHaveLength(1);

    await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      entities: [
        { name: "Apple Inc.", entityType: "organization", mentionText: "Apple" },
        { name: "iPhone", entityType: "product", mentionText: "iPhone" },
      ],
    });

    byChunk = await entityRepo.getByChunkId(chunkId);
    expect(byChunk).toHaveLength(2);
    expect(byChunk.map((e) => e.name).sort()).toEqual(["Apple Inc.", "iPhone"]);
  });

  it("creates one entity_mention per entity", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "en-chunk-2",
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

    const { entities, mentions } = await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      entities: [
        { name: "Apple Inc.", entityType: "organization", mentionText: "Apple" },
        { name: "iPhone", entityType: "product", mentionText: "iPhone" },
      ],
    });

    expect(entities).toHaveLength(2);
    expect(mentions).toHaveLength(2);
    for (const m of mentions) {
      expect(m.chunk_id).toBe(chunkId);
      const linked = entities.find((e) => e.id === m.entity_id);
      expect(linked).toBeDefined();
    }
  });

  it("replaceForChunk with empty entities array clears the chunk", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "en-chunk-3",
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

    await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      entities: [
        { name: "Apple", entityType: "organization", mentionText: "Apple" },
      ],
    });

    const { entities, mentions } = await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      entities: [],
    });

    expect(entities).toHaveLength(0);
    expect(mentions).toHaveLength(0);
    expect(await entityRepo.getByChunkId(chunkId)).toHaveLength(0);
  });

  it("deleteByChunkId removes entities and cascades to mentions", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "en-chunk-4",
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

    const { entities } = await entityRepo.replaceForChunk({
      chunkId,
      documentId,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      entities: [
        { name: "Apple", entityType: "organization", mentionText: "Apple" },
      ],
    });

    await entityRepo.deleteByChunkId(chunkId);
    expect(await entityRepo.getByChunkId(chunkId)).toHaveLength(0);

    const remainingMentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", entities[0].id)
      .execute();
    expect(remainingMentions).toHaveLength(0);
  });
});
