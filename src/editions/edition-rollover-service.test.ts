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
import { createSectionRepository } from "../expansion/section-repository.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createEditionRolloverService } from "./edition-rollover-service.js";
import { REQUIRED_ENRICHMENT_TYPES } from "./enrichment-tracker-repository.js";

const migrationSqlPaths = [
  "../database/migrations/002_create_processing_jobs.sql",
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/004_create_prompt_versions.sql",
  "../database/migrations/007_create_discovery_events.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/009_create_document_sections.sql",
  "../database/migrations/010_create_document_chunks.sql",
  "../database/migrations/017_create_story_clusters.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
  "../database/migrations/026_add_partition_key.sql",
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

describe("EditionRolloverService", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  let sectionRepo: ReturnType<typeof createSectionRepository>;
  let chunkRepo: ReturnType<typeof createChunkRepository>;
  let storyRepo: ReturnType<typeof createStoryRepository>;
  let storySummaryRepo: ReturnType<typeof createStorySummaryRepository>;
  let service: ReturnType<typeof createEditionRolloverService>;
  const schema = schemaName("rollover_test_");

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
    sectionRepo = createSectionRepository(db);
    chunkRepo = createChunkRepository(db);
    storyRepo = createStoryRepository(db);
    storySummaryRepo = createStorySummaryRepository(db);
    service = createEditionRolloverService({ db, editionRepo });
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.story_summary_citations CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_summaries CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.cluster_members CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_clusters CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_chunks CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_sections CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.discovery_events CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs CASCADE`);
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

  async function makeSectionForDoc(documentId: string) {
    return sectionRepo.createBatch([
      {
        documentId,
        order: 0,
        type: "paragraph",
        contentMarkdown: "body",
        contentText: "body text",
        metadata: {},
      },
    ]);
  }

  async function markFullyEnriched(documentId: string) {
    await db
      .insertInto("document_enrichment_status")
      .values(
        REQUIRED_ENRICHMENT_TYPES.map((enrichment_type) => ({
          document_id: documentId,
          enrichment_type,
          status: "done" as const,
          completed_at: new Date(),
        })),
      )
      .execute();
  }

  async function makePrompt(name: string) {
    return db
      .insertInto("prompt_versions")
      .values({ name, version: 1, template: "{{chunk_text}}", purpose: name })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  it("no-ops on a non-mutable edition", async () => {
    const ed = await editionRepo.create("2026-08-01");
    await editionRepo.transition(ed.id, "ready");
    const result = await service.rolloverUnreadyDocuments(ed.id);
    expect(result.movedDocumentCount).toBe(0);
    expect(result.targetEditionId).toBe(ed.id);
  });

  it("no-ops when every document is already in a story with a summary", async () => {
    const ed = await editionRepo.create("2026-08-02");
    const d1 = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://e.com/a",
    });
    const d2 = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://e.com/b",
    });
    const c1 = await makeChunkForDoc(d1.id);
    const c2 = await makeChunkForDoc(d2.id);
    await markFullyEnriched(d1.id);
    await markFullyEnriched(d2.id);
    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [d1.id] },
        { label: "B", documentIds: [d2.id] },
      ],
    });
    const prompt = await makePrompt("story_summary");
    for (const [idx, s] of replaced.stories.entries()) {
      await storySummaryRepo.replaceForStory({
        storyId: s.story.id,
        content: "ok",
        promptId: prompt.id,
        promptVersion: prompt.version,
        model: "m",
        provider: "p",
        inputHash: `h${idx}`,
        claims: [{ text: "claim", chunkId: idx === 0 ? c1 : c2 }],
      });
    }

    const result = await service.rolloverUnreadyDocuments(ed.id);
    expect(result.movedDocumentCount).toBe(0);
    expect(result.deletedStoryIds).toEqual([]);

    const docs = await docRepo.getByEdition(ed.id);
    expect(docs.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it("moves unclustered documents to a fresh next-day edition", async () => {
    const source = await editionRepo.create("2026-08-03");
    const ready = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/ready",
    });
    const stranded = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/stranded",
    });
    const readyChunk = await makeChunkForDoc(ready.id);
    await markFullyEnriched(ready.id);
    await makeChunkForDoc(stranded.id);
    const replaced = await storyRepo.replaceForEdition({
      editionId: source.id,
      stories: [{ label: "A", documentIds: [ready.id] }],
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
      claims: [{ text: "claim", chunkId: readyChunk }],
    });

    const result = await service.rolloverUnreadyDocuments(source.id);
    expect(result.movedDocumentCount).toBe(1);

    const target = await db
      .selectFrom("editions")
      .selectAll()
      .where("id", "=", result.targetEditionId)
      .executeTakeFirstOrThrow();
    expect(target.id).not.toBe(source.id);
    expect(target.status).toBe("building");

    const sourceDocs = await docRepo.getByEdition(source.id);
    expect(sourceDocs.map((d) => d.id)).toEqual([ready.id]);
    const targetDocs = await docRepo.getByEdition(target.id);
    expect(targetDocs.map((d) => d.id)).toEqual([stranded.id]);
  });

  it("repairs a ready edition and requeues a skipped chunk job", async () => {
    const source = await editionRepo.create("2026-08-03");
    const stranded = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/ready-but-stranded",
    });
    await makeSectionForDoc(stranded.id);
    await db
      .insertInto("processing_jobs")
      .values({
        job_type: "chunk_document",
        edition_id: source.id,
        target: JSON.stringify({ documentId: stranded.id }),
        status: "completed",
        completed_at: new Date(),
      })
      .execute();
    await editionRepo.transition(source.id, "ready");

    const result = await service.rolloverUnreadyDocuments(source.id);

    expect(result.movedDocumentCount).toBe(1);
    expect(result.requeuedJobCount).toBe(1);
    const targetJobs = await db
      .selectFrom("processing_jobs")
      .selectAll()
      .where("edition_id", "=", result.targetEditionId)
      .where("job_type", "=", "chunk_document")
      .execute();
    expect(targetJobs).toHaveLength(1);
    expect(targetJobs[0]!.status).toBe("pending");
  });

  it("also moves documents whose story has no summary yet", async () => {
    const source = await editionRepo.create("2026-08-04");
    const lonely = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/lonely",
    });
    await makeChunkForDoc(lonely.id);
    await storyRepo.replaceForEdition({
      editionId: source.id,
      stories: [{ label: "Lonely", documentIds: [lonely.id] }],
    });

    const result = await service.rolloverUnreadyDocuments(source.id);
    expect(result.movedDocumentCount).toBe(1);
    expect(result.deletedStoryIds.length).toBe(1);

    const stories = await storyRepo.getByEdition(source.id);
    expect(stories.length).toBe(0);

    const targetDocs = await docRepo.getByEdition(result.targetEditionId);
    expect(targetDocs.map((d) => d.id)).toEqual([lonely.id]);
  });

  it("leaves stories with summaries and all of their members intact", async () => {
    const source = await editionRepo.create("2026-08-05");
    const ready = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/ready",
    });
    const stranded = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/stranded",
    });
    const readyChunk = await makeChunkForDoc(ready.id);
    await markFullyEnriched(ready.id);
    await makeChunkForDoc(stranded.id);
    const replaced = await storyRepo.replaceForEdition({
      editionId: source.id,
      stories: [{ label: "Solo", documentIds: [ready.id] }],
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
      claims: [{ text: "claim", chunkId: readyChunk }],
    });

    const result = await service.rolloverUnreadyDocuments(source.id);
    expect(result.movedDocumentCount).toBe(1);
    expect(result.deletedStoryIds.length).toBe(0);

    const stories = await storyRepo.getByEdition(source.id);
    expect(stories.length).toBe(1);
    expect(stories[0]!.story.id).toBe(replaced.stories[0]!.story.id);
    expect(stories[0]!.members.map((m) => m.document_id)).toEqual([ready.id]);

    const targetDocs = await docRepo.getByEdition(result.targetEditionId);
    expect(targetDocs.map((d) => d.id)).toEqual([stranded.id]);
  });

  it("re-targets pending processing jobs that target moved documents", async () => {
    const source = await editionRepo.create("2026-08-06");
    const moved = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/moved2",
    });
    const kept = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/kept2",
    });
    await makeChunkForDoc(moved.id);
    const keptChunk = await makeChunkForDoc(kept.id);
    await markFullyEnriched(kept.id);
    const replaced = await storyRepo.replaceForEdition({
      editionId: source.id,
      stories: [{ label: "A", documentIds: [kept.id] }],
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
      claims: [{ text: "claim", chunkId: keptChunk }],
    });

    await db
      .insertInto("processing_jobs")
      .values([
        {
          job_type: "embed_chunk",
          edition_id: source.id,
          target: JSON.stringify({ documentId: moved.id, chunkId: "c1" }),
          status: "pending",
          next_eligible_at: new Date(),
        },
        {
          job_type: "summarize_chunk",
          edition_id: source.id,
          target: JSON.stringify({ documentId: kept.id, chunkId: "c2" }),
          status: "completed",
          next_eligible_at: new Date(),
          completed_at: new Date(),
        },
      ])
      .execute();

    const result = await service.rolloverUnreadyDocuments(source.id);
    expect(result.movedJobCount).toBe(1);
    expect(result.cancelledJobCount).toBe(0);

    const jobsByEdition = await db
      .selectFrom("processing_jobs")
      .selectAll()
      .execute();
    const sourceJobs = jobsByEdition.filter((j) => j.edition_id === source.id);
    const targetJobs = jobsByEdition.filter((j) => j.edition_id === result.targetEditionId);
    expect(sourceJobs.map((j) => j.job_type).sort()).toEqual(["summarize_chunk"]);
    expect(targetJobs.map((j) => j.job_type).sort()).toEqual(["embed_chunk"]);
  });

  it("moves the discovery events whose url matches a moved document", async () => {
    const source = await editionRepo.create("2026-08-07");
    const moved = await docRepo.create({
      editionId: source.id,
      sourceType: "article",
      sourceUrl: "https://e.com/discovered",
    });
    await makeChunkForDoc(moved.id);

    await db
      .insertInto("discovery_events")
      .values([
        {
          edition_id: source.id,
          miniflux_entry_id: "1",
          feed_id: "1",
          title: null,
          url: "https://e.com/discovered",
          hash: null,
          published_at: null,
        },
      ])
      .execute();

    const result = await service.rolloverUnreadyDocuments(source.id);
    expect(result.movedDocumentCount).toBe(1);
    expect(result.movedDiscoveryEventCount).toBe(1);

    const targetEvents = await db
      .selectFrom("discovery_events")
      .selectAll()
      .where("edition_id", "=", result.targetEditionId)
      .execute();
    expect(targetEvents.length).toBe(1);
    expect(targetEvents[0]!.url).toBe("https://e.com/discovered");
  });

  it("throws when the edition does not exist", async () => {
    await expect(service.rolloverUnreadyDocuments("00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(/edition not found/);
  });
});
