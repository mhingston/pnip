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
import { type Database, type ProcessingJob } from "../database/kysely.js";
import { createEditionRepository } from "./edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "./enrichment-gate-service.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import { createChunkDocumentWorker } from "../chunking/chunk-document-worker.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createEditionAssemblyService } from "./edition-assembly-service.js";
import { createEditionReadinessGate } from "./edition-readiness-gate.js";
import { createProvenanceRepository } from "../provenance/provenance-repository.js";
import type { Logger } from "../logging/logger.js";

const migrationSqlPaths = [
  "../database/migrations/002_create_processing_jobs.sql",
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/004_create_prompt_versions.sql",
  "../database/migrations/005_create_document_lineage.sql",
  "../database/migrations/006_add_depends_on_to_processing_jobs.sql",
  "../database/migrations/007_create_discovery_events.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/009_create_document_sections.sql",
  "../database/migrations/010_create_document_chunks.sql",
  "../database/migrations/011_create_pgvector_extension.sql",
  "../database/migrations/012_create_summaries.sql",
  "../database/migrations/013_create_entities.sql",
  "../database/migrations/014_create_topics.sql",
  "../database/migrations/015_create_quality_classifications.sql",
  "../database/migrations/016_create_embeddings.sql",
  "../database/migrations/017_create_story_clusters.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
  "../database/migrations/026_add_partition_key.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

function silentLogger(): Logger {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: function () {
      return this;
    },
  } as unknown as Logger;
}

describe("M6 end-to-end: chunk → enrich → cluster → summarize → ready", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  let sectionRepo: ReturnType<typeof createSectionRepository>;
  let chunkRepo: ReturnType<typeof createChunkRepository>;
  let enrichmentTracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  let enrichmentGate: ReturnType<typeof createEnrichmentGateService>;
  let storyRepo: ReturnType<typeof createStoryRepository>;
  let storySummaryRepo: ReturnType<typeof createStorySummaryRepository>;
  let assembly: ReturnType<typeof createEditionAssemblyService>;
  let readinessGate: ReturnType<typeof createEditionReadinessGate>;
  let provenanceRepo: ReturnType<typeof createProvenanceRepository>;
  const schema = schemaName("m6_e2e_");

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
    sectionRepo = createSectionRepository(db);
    chunkRepo = createChunkRepository(db);
    enrichmentTracker = createEnrichmentTrackerRepository(db);
    enrichmentGate = createEnrichmentGateService({ db, tracker: enrichmentTracker });
    storyRepo = createStoryRepository(db);
    storySummaryRepo = createStorySummaryRepository(db);
    provenanceRepo = createProvenanceRepository(db);
    assembly = createEditionAssemblyService({
      db,
      editionRepo,
      storyRepo,
      storySummaryRepo,
      enrichmentTracker,
    });
    readinessGate = createEditionReadinessGate({ db, editionRepo, assembly });
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.story_summary_citations CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_summaries CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.cluster_members CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.story_clusters CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_enrichment_status`);
    await pool.query(`TRUNCATE TABLE ${schema}.quality_classifications CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.embeddings CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.entities CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.topic_assignments CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.topics CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.summary_citations CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.summaries CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_chunks CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_sections CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.discovery_events CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_lineage CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.prompt_versions CASCADE`);
  });

  afterAll(async () => {
    await db.destroy();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function makeDocInExistingEdition(editionId: string, sourceUrl: string) {
    const doc = await docRepo.create({ editionId, sourceType: "article", sourceUrl });
    const section = await sectionRepo.createBatch([
      {
        documentId: doc.id,
        order: 0,
        type: "paragraph",
        contentMarkdown: "body",
        contentText: "some text",
        metadata: {},
      },
    ]);
    return { document: doc, sectionId: section[0]!.id };
  }

  async function makeEditionWithDoc(editionDate: string, sourceUrl: string) {
    const ed = await editionRepo.create(editionDate);
    const made = await makeDocInExistingEdition(ed.id, sourceUrl);
    return { edition: ed, document: made.document, sectionId: made.sectionId };
  }

  async function runChunkWorker(documentId: string, editionId: string) {
    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });
    const job: ProcessingJob = {
      id: randomUUID(),
      job_type: "chunk_document",
      edition_id: editionId,
      target: { documentId },
      status: "running",
      retry_count: 0,
      last_error: null,
      last_attempt_at: null,
      next_eligible_at: new Date(),
      locked_by: "test",
      locked_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      depends_on: [],
    };
    return worker.execute(job, { db, logger: silentLogger() });
  }

  async function fakeEnrich(
    documentId: string,
    editionId: string,
    chunkId: string,
    jobType:
      | "summarize_chunk"
      | "extract_entities"
      | "assign_topics"
      | "embed_chunk"
      | "classify_quality",
  ) {
    const gateResult = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(
      editionId,
      documentId,
      jobType,
    );
    return { chunkId, jobType, gateResult };
  }

  it("drives an edition from Building to Ready with all 5 enrichments and a 2-document cluster", async () => {
    const ed = await editionRepo.create("2026-05-01");
    const a = await makeDocInExistingEdition(ed.id, "https://e.com/1a");
    const b = await makeDocInExistingEdition(ed.id, "https://e.com/1b");

    const outA = await runChunkWorker(a.document.id, ed.id);
    expect(outA.childJobs!.length).toBe(5);
    expect(outA.childJobs!.map((j) => j.jobType).sort()).toEqual(
      ["assign_topics", "classify_quality", "embed_chunk", "extract_entities", "summarize_chunk"],
    );

    const outB = await runChunkWorker(b.document.id, ed.id);
    expect(outB.childJobs!.length).toBe(5);

    expect(await enrichmentTracker.isEditionFullyEnriched(ed.id)).toBe(false);
    expect(await enrichmentTracker.getEditionEnqueuedAt(ed.id)).toBeNull();

    const chunksA = await chunkRepo.getByDocumentId(a.document.id);
    const chunksB = await chunkRepo.getByDocumentId(b.document.id);
    const chunkAId = chunksA[0]!.id;
    const chunkBId = chunksB[0]!.id;

    for (const t of REQUIRED_ENRICHMENT_TYPES.slice(0, 4)) {
      const r1 = await fakeEnrich(a.document.id, ed.id, chunkAId, t);
      const r2 = await fakeEnrich(b.document.id, ed.id, chunkBId, t);
      expect(r1.gateResult).toBeNull();
      expect(r2.gateResult).toBeNull();
    }

    const r1 = await fakeEnrich(a.document.id, ed.id, chunkAId, "classify_quality");
    expect(r1.gateResult).toBeNull();
    const r2 = await fakeEnrich(b.document.id, ed.id, chunkBId, "classify_quality");
    expect(r2.gateResult).not.toBeNull();
    expect(r2.gateResult!.jobType).toBe("cluster_stories");
    expect(r2.gateResult!.editionId).toBe(ed.id);

    expect(await enrichmentTracker.getEditionEnqueuedAt(ed.id)).toBeInstanceOf(Date);

    const r3 = await fakeEnrich(a.document.id, ed.id, chunkAId, "classify_quality");
    expect(r3.gateResult).toBeNull();

    const replaced = await storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "A", documentIds: [a.document.id, b.document.id] },
      ],
    });
    const storyId = replaced.stories[0]!.story.id;
    const promptInserted = await db
      .insertInto("prompt_versions")
      .values({ name: "story_summary", version: 1, template: "t", purpose: "s" })
      .returningAll()
      .executeTakeFirstOrThrow();
    await storySummaryRepo.replaceForStory({
      storyId,
      content: "Master summary",
      promptId: promptInserted.id,
      promptVersion: promptInserted.version,
      model: "fake",
      provider: "fake",
      inputHash: "h",
      claims: [{ text: "claim", chunkId: chunkAId }],
    });

    expect(await assembly.isEditionReady(ed.id)).toBe(true);
    const r = await readinessGate.transitionToReadyIfReady(ed.id);
    expect(r.transitioned).toBe(true);
    expect(r.edition.status).toBe("ready");

    const a2 = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      a.document.id,
      "summarize_chunk",
    );
    expect(a2).toBeNull();
  });

  it("a re-chunk resets the per-document tracker; subsequent enrichment re-fires the gate after the edition claim is reset", async () => {
    const ed = await editionRepo.create("2026-05-02");
    const a = await makeDocInExistingEdition(ed.id, "https://e.com/2a");
    await runChunkWorker(a.document.id, ed.id);
    const chunks = await chunkRepo.getByDocumentId(a.document.id);
    const chunkId = chunks[0]!.id;
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await fakeEnrich(a.document.id, ed.id, chunkId, t);
    }
    expect(await enrichmentTracker.isDocumentFullyEnriched(a.document.id)).toBe(true);
    expect(await enrichmentTracker.getEditionEnqueuedAt(ed.id)).toBeInstanceOf(Date);

    await runChunkWorker(a.document.id, ed.id);
    expect(await enrichmentTracker.getCompletedTypesForDocument(a.document.id)).toEqual([]);
    expect(await enrichmentTracker.isDocumentFullyEnriched(a.document.id)).toBe(false);

    await enrichmentTracker.resetEditionEnqueue(ed.id);

    const newChunks = await chunkRepo.getByDocumentId(a.document.id);
    const newChunkId = newChunks[0]!.id;
    for (const t of REQUIRED_ENRICHMENT_TYPES.slice(0, 4)) {
      const r = await fakeEnrich(a.document.id, ed.id, newChunkId, t);
      expect(r.gateResult).toBeNull();
    }
    const final = await fakeEnrich(a.document.id, ed.id, newChunkId, "classify_quality");
    expect(final.gateResult).not.toBeNull();
    expect(final.gateResult!.jobType).toBe("cluster_stories");
  });

  it("workers in non-mutable state no-op without mutating or invoking the gate", async () => {
    const ed = await editionRepo.create("2026-05-03");
    const a = await makeDocInExistingEdition(ed.id, "https://e.com/3");
    const localEditionRepo = {
      ...editionRepo,
      isProcessingAllowed: async () => false,
    };
    const chunkWorker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo: localEditionRepo,
    });
    const job: ProcessingJob = {
      id: randomUUID(),
      job_type: "chunk_document",
      edition_id: ed.id,
      target: { documentId: a.document.id },
      status: "running",
      retry_count: 0,
      last_error: null,
      last_attempt_at: null,
      next_eligible_at: new Date(),
      locked_by: "test",
      locked_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      depends_on: [],
    };
    const outcome = await chunkWorker.execute(job, { db, logger: silentLogger() });
    expect(outcome).toEqual({});
    expect(await chunkRepo.getByDocumentId(a.document.id)).toEqual([]);
  });
});
