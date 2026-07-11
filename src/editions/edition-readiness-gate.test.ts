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
import { createEditionReadinessGate } from "./edition-readiness-gate.js";

const migrationSqlPaths = [
  "../database/migrations/002_create_processing_jobs.sql",
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/004_create_prompt_versions.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/009_create_document_sections.sql",
  "../database/migrations/010_create_document_chunks.sql",
  "../database/migrations/017_create_story_clusters.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
];

const partitionKeyDdl = `
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

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EditionReadinessGate", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let gate: ReturnType<typeof createEditionReadinessGate>;
  let assembly: ReturnType<typeof createEditionAssemblyService>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  let tracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  let storyRepo: ReturnType<typeof createStoryRepository>;
  let storySummaryRepo: ReturnType<typeof createStorySummaryRepository>;
  let sectionRepo: ReturnType<typeof createSectionRepository>;
  let chunkRepo: ReturnType<typeof createChunkRepository>;
  const schema = schemaName("readiness_test_");

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
      await client.query(partitionKeyDdl);
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
    gate = createEditionReadinessGate({ db, editionRepo, assembly });
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

  async function makePrompt(name: string) {
    return db
      .insertInto("prompt_versions")
      .values({ name, version: 1, template: "{{chunk_text}}", purpose: name })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  it("does not transition a building edition with zero documents to ready", async () => {
    const ed = await editionRepo.create("2026-04-01");
    const r = await gate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(false);
    expect(r.edition.status).toBe("building");
    expect(r.reason).toMatch(/no documents/i);
  });

  it("does not transition a building edition that has documents but is not fully enriched", async () => {
    const ed = await editionRepo.create("2026-04-02");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/2" });
    await tracker.markDone(d1.id, "summarize_chunk");
    const r = await gate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(false);
    expect(r.edition.status).toBe("building");
    expect(r.reason).toMatch(/0\/1 documents fully enriched/);
  });

  it("transitions a building edition to ready when every document is fully enriched and every story is summarized", async () => {
    const ed = await editionRepo.create("2026-04-03");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/3a" });
    const d2 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/3b" });
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
    for (let i = 0; i < replaced.stories.length; i++) {
      const s = replaced.stories[i]!;
      await storySummaryRepo.replaceForStory({
        storyId: s.story.id,
        content: "ok",
        promptId: prompt.id,
        promptVersion: prompt.version,
        model: "m",
        provider: "p",
        inputHash: "h",
        claims: [{ text: "claim", chunkId: i === 0 ? c1 : c2 }],
      });
    }
    const r = await gate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(true);
    expect(r.edition.status).toBe("ready");
    expect(r.reason).toMatch(/fully ready/);
  });

  it("does not transition a non-building edition (skipping ready without modification)", async () => {
    const ed = await editionRepo.create("2026-04-04");
    await editionRepo.transition(ed.id, "ready");
    const r = await gate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(false);
    expect(r.edition.status).toBe("ready");
    expect(r.reason).toMatch(/not 'building'/);
  });

  it("does not transition a published edition (immutability)", async () => {
    const ed = await editionRepo.create("2026-04-05");
    await editionRepo.transition(ed.id, "ready");
    await editionRepo.transition(ed.id, "publishing");
    await editionRepo.transition(ed.id, "published");
    const r = await gate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(false);
    expect(r.edition.status).toBe("published");
    expect(r.reason).toMatch(/not 'building'/);
  });

  it("second call after a successful transition is a no-op (already ready)", async () => {
    const ed = await editionRepo.create("2026-04-06");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/6" });
    const c1 = await makeChunkForDoc(d1.id);
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(d1.id, t);
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [{ label: "A", documentIds: [d1.id] }],
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
    const first = await gate.transitionToReadyIfReady(ed.id);
    expect(first.transitioned).toBe(true);
    const second = await gate.transitionToReadyIfReady(ed.id);
    expect(second.transitioned).toBe(false);
    expect(second.edition.status).toBe("ready");
  });
});
