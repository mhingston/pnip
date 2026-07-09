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
} from "../chunking/chunk-repository.js";
import {
  createPromptRepository,
  type PromptRepository,
} from "../prompts/prompt-repository.js";
import {
  createStoryRepository,
  type StoryRepository,
} from "./story-repository.js";
import {
  createStorySummaryRepository,
  type StorySummaryRepository,
} from "./story-summary-repository.js";

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
const promptMigrationPath = fileURLToPath(
  new URL("../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);
const storyMigrationPath = fileURLToPath(
  new URL(
    "../database/migrations/017_create_story_clusters.sql",
    import.meta.url,
  ),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("StorySummaryRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let promptRepo: PromptRepository;
  let storyRepo: StoryRepository;
  let storySummaryRepo: StorySummaryRepository;
  const schema = schemaName("ssum_");
  let editionId: string;
  let documentId: string;
  let sectionId: string;
  let chunkA: string;
  let chunkB: string;
  let storyId: string;
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
    const storySql = await readFile(storyMigrationPath, "utf8");

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
      await client.query(storySql);
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
    storyRepo = createStoryRepository(db);
    storySummaryRepo = createStorySummaryRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-08-01") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;

    const doc = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/story-summary-test",
    });
    documentId = doc.id;

    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, type: "title", contentText: "Title" },
    ]);
    sectionId = sections[0].id;

    const chunks = await chunkRepo.createBatch([
      {
        id: "ssum-chunk-a",
        documentId,
        sectionId,
        sequence: 0,
        text: "First chunk.",
        tokenCount: 2,
        startOffset: 0,
        endOffset: 12,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
      {
        id: "ssum-chunk-b",
        documentId,
        sectionId,
        sequence: 1,
        text: "Second chunk.",
        tokenCount: 2,
        startOffset: 13,
        endOffset: 26,
        paragraphStart: 1,
        paragraphEnd: 1,
      },
    ]);
    chunkA = chunks[0].id;
    chunkB = chunks[1].id;

    const { stories } = await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "story-1", documentIds: [documentId] }],
    });
    storyId = stories[0].story.id;

    const prompt = await promptRepo.createNewVersion({
      name: "story_summary",
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
    await db.deleteFrom("story_summary_citations").execute();
    await db.deleteFrom("story_summaries").execute();
  });

  it("replaces summary for a story (idempotent)", async () => {
    await storySummaryRepo.replaceForStory({
      storyId,
      content: "First.",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      claims: [{ text: "c1", chunkId: chunkA }],
    });

    await storySummaryRepo.replaceForStory({
      storyId,
      content: "Second.",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      claims: [
        { text: "c1", chunkId: chunkA },
        { text: "c2", chunkId: chunkB },
      ],
    });

    const fetched = await storySummaryRepo.getByStoryId(storyId);
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("Second.");
    expect(fetched!.input_hash).toBe("h2");

    const citations = await storySummaryRepo.getCitationsBySummaryId(
      fetched!.id,
    );
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.chunk_id).sort()).toEqual([chunkA, chunkB].sort());
  });

  it("rejects empty claims", async () => {
    await expect(
      storySummaryRepo.replaceForStory({
        storyId,
        content: "x",
        promptId,
        promptVersion: 1,
        model: "m",
        provider: "p",
        inputHash: "h",
        claims: [],
      }),
    ).rejects.toThrow(/at least one claim/);
  });

  it("citation order is preserved", async () => {
    const { summary, citations } = await storySummaryRepo.replaceForStory({
      storyId,
      content: "Ordered.",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h",
      claims: [
        { text: "first", chunkId: chunkA },
        { text: "second", chunkId: chunkB },
        { text: "third", chunkId: chunkA },
      ],
    });
    expect(summary.content).toBe("Ordered.");
    expect(citations.map((c) => c.claim_order)).toEqual([0, 1, 2]);
    expect(citations.map((c) => c.claim_text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("story_summary is unique per story (replaces previous)", async () => {
    await storySummaryRepo.replaceForStory({
      storyId,
      content: "v1",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h1",
      claims: [{ text: "c1", chunkId: chunkA }],
    });

    const s1 = await storySummaryRepo.getByStoryId(storyId);
    expect(s1!.content).toBe("v1");

    await storySummaryRepo.replaceForStory({
      storyId,
      content: "v2",
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: "h2",
      claims: [{ text: "c1", chunkId: chunkA }],
    });

    const s2 = await storySummaryRepo.getByStoryId(storyId);
    expect(s2!.content).toBe("v2");
    expect(s2!.id).not.toBe(s1!.id);
  });
});
