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
import { Kysely, PostgresDialect, CompiledQuery, sql } from "kysely";
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
  createEmbeddingRepository,
  type EmbeddingRepository,
} from "./embedding-repository.js";
import { vectorToSql, sqlToVector } from "../../common/vector-codec.js";

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
const vectorMigrationPath = fileURLToPath(
  new URL("../../database/migrations/011_create_pgvector_extension.sql", import.meta.url),
);
const embeddingMigrationPath = fileURLToPath(
  new URL("../../database/migrations/016_create_embeddings.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EmbeddingRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let embeddingRepo: EmbeddingRepository;
  const schema = schemaName("embed_");
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
    const vectorSql = await readFile(vectorMigrationPath, "utf8");
    const embeddingSql = await readFile(embeddingMigrationPath, "utf8");

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
      await client.query(vectorSql);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(sectionSql);
      await client.query(chunkSql);
      await client.query(embeddingSql);
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
    embeddingRepo = createEmbeddingRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-06-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/embed-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
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
    await db.deleteFrom("embeddings").execute();
    await db.deleteFrom("document_chunks").execute();
  });

  it("stores and retrieves a 384-dim vector with cosine distance queryable", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "em-chunk-1",
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

    const vector = Array.from({ length: 384 }, (_, i) => (i + 1) / 1000);
    const inserted = await embeddingRepo.replaceForChunk({
      chunkId,
      vector,
      model: "test-embed",
      provider: "fake",
      inputHash: "h1",
    });

    expect(inserted.vector.length).toBe(384);
    expect(inserted.vector[0]).toBeCloseTo(vector[0], 5);
    expect(inserted.vector[383]).toBeCloseTo(vector[383], 5);

    const fetched = await embeddingRepo.getByChunkId(chunkId);
    expect(fetched).toBeDefined();
    expect(fetched!.vector.length).toBe(384);
    expect(fetched!.vector[0]).toBeCloseTo(vector[0], 5);
    expect(fetched!.vector[383]).toBeCloseTo(vector[383], 5);

    const distance = await db
      .selectFrom("embeddings")
      .select((eb) => [
        sql<number>`vector <=> ${vectorToSql(vector)}::vector`.as("dist"),
      ])
      .where("chunk_id", "=", chunkId)
      .executeTakeFirst();
    expect(distance).toBeDefined();
    expect(Number((distance as { dist: number }).dist)).toBeCloseTo(0, 5);
  });

  it("replaces existing embedding for a chunk (idempotent)", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "em-chunk-2",
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

    const v1 = makeRandomVector();
    await embeddingRepo.replaceForChunk({
      chunkId,
      vector: v1,
      model: "m",
      provider: "p",
      inputHash: "h1",
    });

    const v2 = makeRandomVector();
    await embeddingRepo.replaceForChunk({
      chunkId,
      vector: v2,
      model: "m",
      provider: "p",
      inputHash: "h2",
    });

    const all = await embeddingRepo.getByDocumentId(documentId);
    expect(all).toHaveLength(1);
    expect(all[0].input_hash).toBe("h2");
    expect(all[0].vector.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(all[0].vector[i]).toBeCloseTo(v2[i], 5);
    }
  });

  it("getByDocumentId returns one embedding per chunk of the document", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "em-chunk-3",
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
        id: "em-chunk-4",
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
      await embeddingRepo.replaceForChunk({
        chunkId: c.id,
        vector: makeRandomVector(),
        model: "m",
        provider: "p",
        inputHash: c.id,
      });
    }

    const all = await embeddingRepo.getByDocumentId(documentId);
    expect(all).toHaveLength(2);
  });

  it("deleteByChunkId removes the embedding", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "em-chunk-5",
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

    await embeddingRepo.replaceForChunk({
      chunkId,
      vector: makeRandomVector(),
      model: "m",
      provider: "p",
      inputHash: "h",
    });
    expect(await embeddingRepo.getByChunkId(chunkId)).toBeDefined();

    await embeddingRepo.deleteByChunkId(chunkId);
    expect(await embeddingRepo.getByChunkId(chunkId)).toBeUndefined();
  });

  function makeRandomVector(): number[] {
    return Array.from({ length: 384 }, () => Math.random());
  }

  it("sqlToVector <-> vectorToSql round-trips for fetched row", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "em-chunk-6",
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

    const v = makeRandomVector();
    await embeddingRepo.replaceForChunk({
      chunkId,
      vector: v,
      model: "m",
      provider: "p",
      inputHash: "h",
    });

    const raw = await db
      .selectFrom("embeddings")
      .select("vector")
      .where("chunk_id", "=", chunkId)
      .executeTakeFirstOrThrow();
    const rawVec = (raw as { vector: string | number[] }).vector;
    const text = typeof rawVec === "string" ? rawVec : vectorToSql(rawVec as number[]);
    const roundTripped = sqlToVector(text);
    expect(roundTripped.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(roundTripped[i]).toBeCloseTo(v[i], 5);
    }
  });
});
