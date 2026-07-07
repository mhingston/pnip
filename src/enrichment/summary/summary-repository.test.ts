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
  createSummaryRepository,
  type SummaryRepository,
} from "./summary-repository.js";

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
const summaryMigrationPath = fileURLToPath(
  new URL("../../database/migrations/012_create_summaries.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("SummaryRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let promptRepo: PromptRepository;
  let summaryRepo: SummaryRepository;
  const schema = schemaName("summary_");
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
    const summarySql = await readFile(summaryMigrationPath, "utf8");

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(sectionSql);
      await client.query(chunkSql);
      await client.query(promptSql);
      await client.query(summarySql);
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
    summaryRepo = createSummaryRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-02-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/summary-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
    ]);
    sectionId = sections[0].id;

    const prompt = await promptRepo.createNewVersion({
      name: "summary",
      template: "Summarize: {{chunk_text}}",
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
    await db.deleteFrom("summary_citations").execute();
    await db.deleteFrom("summaries").execute();
    await db.deleteFrom("document_chunks").execute();
  });

  it("replaces existing summary for a chunk (idempotent)", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "sm-chunk-1",
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

    await summaryRepo.replaceForChunk({
      chunkId,
      documentId,
      content: "First summary",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      claims: [{ text: "First claim", chunkId }],
    });

    const before = await summaryRepo.getByChunkId(chunkId);
    expect(before?.content).toBe("First summary");

    await summaryRepo.replaceForChunk({
      chunkId,
      documentId,
      content: "Second summary",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      claims: [
        { text: "Second claim A", chunkId },
        { text: "Second claim B", chunkId },
      ],
    });

    const all = await summaryRepo.getByDocumentId(documentId);
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Second summary");
    expect(all[0].input_hash).toBe("h2");

    const citations = await summaryRepo.getCitationsBySummaryId(all[0].id);
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.claim_text)).toEqual(["Second claim A", "Second claim B"]);
    expect(citations.map((c) => c.claim_order)).toEqual([0, 1]);
  });

  it("rejects empty claims array", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "sm-chunk-2",
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

    await expect(
      summaryRepo.replaceForChunk({
        chunkId: chunks[0].id,
        documentId,
        content: "summary",
        promptId,
        promptVersion: 1,
        model: "m",
        provider: "p",
        inputHash: "h",
        claims: [],
      }),
    ).rejects.toThrow(/at least one claim/);
  });

  it("deleteByChunkId removes summary and cascades citations", async () => {
    const chunks = await chunkRepo.createBatch([
      {
        id: "sm-chunk-3",
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

    const { summary } = await summaryRepo.replaceForChunk({
      chunkId,
      documentId,
      content: "c",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      claims: [{ text: "claim", chunkId }],
    });

    expect(await summaryRepo.getByChunkId(chunkId)).toBeDefined();

    await summaryRepo.deleteByChunkId(chunkId);
    expect(await summaryRepo.getByChunkId(chunkId)).toBeUndefined();

    const remainingCitations = await db
      .selectFrom("summary_citations")
      .selectAll()
      .where("summary_id", "=", summary.id)
      .execute();
    expect(remainingCitations).toHaveLength(0);
  });

  it("getByChunkId returns undefined for unknown chunk", async () => {
    const s = await summaryRepo.getByChunkId("00000000");
    expect(s).toBeUndefined();
  });
});
