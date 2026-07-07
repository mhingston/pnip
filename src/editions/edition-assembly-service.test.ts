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
import { type Database } from "../database/kysely.js";
import { createEditionRepository } from "./edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import { createEditionAssemblyService } from "./edition-assembly-service.js";

const migrationSqlPaths = [
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/004_create_prompt_versions.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/009_create_document_sections.sql",
  "../database/migrations/010_create_document_chunks.sql",
  "../database/migrations/017_create_story_clusters.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EditionAssemblyService", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let assembly: ReturnType<typeof createEditionAssemblyService>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  let tracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  let storyRepo: ReturnType<typeof createStoryRepository>;
  let storySummaryRepo: ReturnType<typeof createStorySummaryRepository>;
  let sectionRepo: ReturnType<typeof createSectionRepository>;
  let chunkRepo: ReturnType<typeof createChunkRepository>;
  const schema = schemaName("assembly_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set for integration tests");
    pool = createPool(url);
    kyselyPool = createPool(url);

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const rel of migrationSqlPaths) {
        const sql = await readMigrationSql(rel);
        await client.query(sql);
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
    editionRepo = createEditionRepository(db);
    docRepo = createDocumentRepository(db);
    tracker = createEnrichmentTrackerRepository(db);
    storyRepo = createStoryRepository(db);
    storySummaryRepo = createStorySummaryRepository(db);
    sectionRepo = createSectionRepository(db);
    chunkRepo = createChunkRepository(db);
    assembly = createEditionAssemblyService({
      db,
      editionRepo,
      storyRepo,
      storySummaryRepo,
      enrichmentTracker: tracker,
    });
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.story_summary_citations CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_summaries CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.cluster_members CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_clusters CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_enrichment_status`);
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.prompt_versions CASCADE`);
  });

  afterAll(async () => {
    await db.destroy();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function makePrompt(name: string) {
    const inserted = await db
      .insertInto("prompt_versions")
      .values({
        name,
        version: 1,
        template: "{{chunk_text}}",
        purpose: name,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return inserted;
  }

  async function makeEdition(editionDate: string) {
    return editionRepo.create(editionDate);
  }

  async function makeDoc(editionId: string, sourceUrl: string) {
    return docRepo.create({ editionId, sourceType: "article", sourceUrl });
  }

  async function makeChunkForDoc(documentId: string, idx = 0) {
    const section = await sectionRepo.createBatch([
      {
        documentId,
        order: 0,
        type: "paragraph",
        contentMarkdown: "body",
        contentText: "body text",
        metadata: {},
      },
    ]);
    const chunks = await chunkRepo.createBatch([
      {
        id: `chunk-${documentId}-${idx}`,
        documentId,
        sectionId: section[0]!.id,
        sequence: 0,
        text: "body text",
        tokenCount: 2,
        startOffset: 0,
        endOffset: 9,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    return chunks[0]!.id;
  }

  it("getReadiness reports not-ready when the edition has zero documents", async () => {
    const ed = await makeEdition("2026-03-01");
    const r = await assembly.getReadiness(ed.id);
    expect(r.isReady).toBe(false);
    expect(r.totalDocuments).toBe(0);
    expect(r.reason).toMatch(/no documents/i);
  });

  it("getReadiness reports not-ready when documents exist but are not fully enriched", async () => {
    const ed = await makeEdition("2026-03-02");
    await makeDoc(ed.id, "https://e.com/2a");
    await makeDoc(ed.id, "https://e.com/2b");
    const r = await assembly.getReadiness(ed.id);
    expect(r.isReady).toBe(false);
    expect(r.totalDocuments).toBe(2);
    expect(r.fullyEnrichedDocuments).toBe(0);
    expect(r.reason).toMatch(/0\/2 documents fully enriched/);
  });

  it("getReadiness reports not-ready when all documents enriched but stories have no summaries", async () => {
    const ed = await makeEdition("2026-03-03");
    const d1 = await makeDoc(ed.id, "https://e.com/3a");
    const d2 = await makeDoc(ed.id, "https://e.com/3b");
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await tracker.markDone(d1.id, t);
      await tracker.markDone(d2.id, t);
    }
    await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [d1.id, d2.id] },
      ],
    });
    const r = await assembly.getReadiness(ed.id);
    expect(r.isReady).toBe(false);
    expect(r.totalDocuments).toBe(2);
    expect(r.fullyEnrichedDocuments).toBe(2);
    expect(r.storiesWithSummaries).toBe(0);
    expect(r.reason).toMatch(/0\/1 stories have summaries/);
  });

  it("getReadiness reports ready only when every doc is enriched AND every story is summarized", async () => {
    const ed = await makeEdition("2026-03-04");
    const d1 = await makeDoc(ed.id, "https://e.com/4a");
    const d2 = await makeDoc(ed.id, "https://e.com/4b");
    const c1 = await makeChunkForDoc(d1.id);
    const c2 = await makeChunkForDoc(d2.id);
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await tracker.markDone(d1.id, t);
      await tracker.markDone(d2.id, t);
    }
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [d1.id] },
        { label: "B", documentIds: [d2.id] },
      ],
    });
    const prompt = await makePrompt("story_summary");
    const chunkByStory = new Map<string, string>();
    for (const s of replaced.stories) {
      chunkByStory.set(s.story.id, s.story.label === "A" ? c1 : c2);
    }
    for (const s of replaced.stories) {
      await storySummaryRepo.replaceForStory({
        storyId: s.story.id,
        content: "summary",
        promptId: prompt.id,
        promptVersion: prompt.version,
        model: "m",
        provider: "p",
        inputHash: "h",
        claims: [{ text: "claim", chunkId: chunkByStory.get(s.story.id)! }],
      });
    }
    const r = await assembly.getReadiness(ed.id);
    expect(r.isReady).toBe(true);
    expect(r.storiesWithSummaries).toBe(2);
    expect(r.reason).toMatch(/all documents fully enriched and all stories have summaries/);
  });

  it("isEditionReady is a thin alias for getReadiness().isReady", async () => {
    const ed = await makeEdition("2026-03-05");
    expect(await assembly.isEditionReady(ed.id)).toBe(false);
    const d1 = await makeDoc(ed.id, "https://e.com/5");
    const c1 = await makeChunkForDoc(d1.id);
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(d1.id, t);
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [{ label: "S", documentIds: [d1.id] }],
    });
    expect(await assembly.isEditionReady(ed.id)).toBe(false);
    const prompt = await makePrompt("story_summary");
    await storySummaryRepo.replaceForStory({
      storyId: replaced.stories[0]!.story.id,
      content: "ok",
      promptId: prompt.id,
      promptVersion: prompt.version,
      model: "m",
      provider: "p",
      inputHash: "h",
      claims: [{ text: "claim", chunkId: c1 }],
    });
    expect(await assembly.isEditionReady(ed.id)).toBe(true);
  });

  it("collectStories returns stories in deterministic (cluster_order, label) order with hasSummary flag", async () => {
    const ed = await makeEdition("2026-03-06");
    const d1 = await makeDoc(ed.id, "https://e.com/6a");
    const d2 = await makeDoc(ed.id, "https://e.com/6b");
    const d3 = await makeDoc(ed.id, "https://e.com/6c");
    const c1 = await makeChunkForDoc(d1.id);
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [d1.id, d3.id] },
        { label: "B", documentIds: [d2.id] },
      ],
    });
    const prompt = await makePrompt("story_summary");
    await storySummaryRepo.replaceForStory({
      storyId: replaced.stories[0]!.story.id,
      content: "ok",
      promptId: prompt.id,
      promptVersion: prompt.version,
      model: "m",
      provider: "p",
      inputHash: "h",
      claims: [{ text: "claim", chunkId: c1 }],
    });

    const stories = await assembly.collectStories(ed.id);
    expect(stories.map((s) => s.story.label)).toEqual(["A", "B"]);
    expect(stories[0]!.hasSummary).toBe(true);
    expect(stories[0]!.summaryId).not.toBeNull();
    expect(stories[1]!.hasSummary).toBe(false);
    expect(stories[1]!.summaryId).toBeNull();
  });

  it("collectStories is deterministic across repeated calls (idempotent ordering)", async () => {
    const ed = await makeEdition("2026-03-07");
    const d1 = await makeDoc(ed.id, "https://e.com/7a");
    const d2 = await makeDoc(ed.id, "https://e.com/7b");
    await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [d1.id] },
        { label: "B", documentIds: [d2.id] },
      ],
    });
    const a = await assembly.collectStories(ed.id);
    const b = await assembly.collectStories(ed.id);
    expect(a.map((s) => s.story.label)).toEqual(b.map((s) => s.story.label));
    expect(a.map((s) => s.story.id)).toEqual(b.map((s) => s.story.id));
  });

  it("assemble returns the full snapshot: edition, stories, readiness, and reasons", async () => {
    const ed = await makeEdition("2026-03-08");
    const d1 = await makeDoc(ed.id, "https://e.com/8a");
    const d2 = await makeDoc(ed.id, "https://e.com/8b");
    const c1 = await makeChunkForDoc(d1.id);
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await tracker.markDone(d1.id, t);
      await tracker.markDone(d2.id, t);
    }
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [{ label: "X", documentIds: [d1.id, d2.id] }],
    });
    const prompt = await makePrompt("story_summary");
    await storySummaryRepo.replaceForStory({
      storyId: replaced.stories[0]!.story.id,
      content: "ok",
      promptId: prompt.id,
      promptVersion: prompt.version,
      model: "m",
      provider: "p",
      inputHash: "h",
      claims: [{ text: "claim", chunkId: c1 }],
    });
    const result = await assembly.assemble(ed.id);
    expect(result.edition.id).toBe(ed.id);
    expect(result.stories.length).toBe(1);
    expect(result.stories[0]!.story.label).toBe("X");
    expect(result.totalDocuments).toBe(2);
    expect(result.fullyEnrichedDocuments).toBe(2);
    expect(result.storiesWithSummaries).toBe(1);
    expect(result.isReady).toBe(true);
    expect(result.reason).toMatch(/all documents fully enriched/);
  });

  it("assemble throws for a missing edition", async () => {
    await expect(assembly.assemble(randomUUID())).rejects.toThrow(/not found/i);
  });
});
