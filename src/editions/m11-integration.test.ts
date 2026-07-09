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
import { createEditionRepository } from "./edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "./enrichment-gate-service.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createEditionAssemblyService } from "./edition-assembly-service.js";
import { createEditionReadinessGate } from "./edition-readiness-gate.js";
import { createMarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import { createEmailDigestRepository } from "../digest/html/email-digest-repository.js";
import { createNotebookRepository } from "../digest/notebooklm/notebook-repository.js";
import { createPodcastRepository } from "../digest/notebooklm/podcast-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import {
  createPublicationService,
  PublicationGateFailedError,
} from "../publication/publication-service.js";
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
  "../database/migrations/020_create_markdown_digests.sql",
  "../database/migrations/021_create_email_digests.sql",
  "../database/migrations/022_create_notebooks.sql",
  "../database/migrations/023_create_podcasts.sql",
  "../database/migrations/026_add_partition_key.sql",
  "../database/migrations/027_add_notebook_podcast_partition.sql",
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

interface TestEnv {
  pool: PgPool;
  db: Kysely<Database>;
  editionRepo: ReturnType<typeof createEditionRepository>;
  docRepo: ReturnType<typeof createDocumentRepository>;
  sectionRepo: ReturnType<typeof createSectionRepository>;
  chunkRepo: ReturnType<typeof createChunkRepository>;
  enrichmentTracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  enrichmentGate: ReturnType<typeof createEnrichmentGateService>;
  storyRepo: ReturnType<typeof createStoryRepository>;
  storySummaryRepo: ReturnType<typeof createStorySummaryRepository>;
  assembly: ReturnType<typeof createEditionAssemblyService>;
  readinessGate: ReturnType<typeof createEditionReadinessGate>;
  markdownDigestRepo: ReturnType<typeof createMarkdownDigestRepository>;
  emailDigestRepo: ReturnType<typeof createEmailDigestRepository>;
  notebookRepo: ReturnType<typeof createNotebookRepository>;
  podcastRepo: ReturnType<typeof createPodcastRepository>;
  jobQueue: ReturnType<typeof createProcessingJobQueue>;
  service: ReturnType<typeof createPublicationService>;
}

async function makeEnv(pool: PgPool, db: Kysely<Database>): Promise<TestEnv> {
  const editionRepo = createEditionRepository(db);
  const docRepo = createDocumentRepository(db);
  const sectionRepo = createSectionRepository(db);
  const chunkRepo = createChunkRepository(db);
  const enrichmentTracker = createEnrichmentTrackerRepository(db);
  const enrichmentGate = createEnrichmentGateService({ db, tracker: enrichmentTracker });
  const storyRepo = createStoryRepository(db);
  const storySummaryRepo = createStorySummaryRepository(db);
  const assembly = createEditionAssemblyService({
    db,
    editionRepo,
    storyRepo,
    storySummaryRepo,
    enrichmentTracker,
  });
  const readinessGate = createEditionReadinessGate({ db, editionRepo, assembly });
  const markdownDigestRepo = createMarkdownDigestRepository(db);
  const emailDigestRepo = createEmailDigestRepository(db);
  const notebookRepo = createNotebookRepository(db);
  const podcastRepo = createPodcastRepository(db);
  const jobQueue = createProcessingJobQueue(db);
  const service = createPublicationService({
    db,
    editionRepo,
    markdownDigestRepo,
    emailDigestRepo,
    notebookRepo,
    podcastRepo,
    jobQueue,
    logger: silentLogger(),
  });
  return {
    pool,
    db,
    editionRepo,
    docRepo,
    sectionRepo,
    chunkRepo,
    enrichmentTracker,
    enrichmentGate,
    storyRepo,
    storySummaryRepo,
    assembly,
    readinessGate,
    markdownDigestRepo,
    emailDigestRepo,
    notebookRepo,
    podcastRepo,
    jobQueue,
    service,
  };
}

const itWithDb = process.env.TEST_DATABASE_URL ? it : it.skip;

describe("M11 end-to-end: publication gate + Ready → Publishing → Published + job cancellation", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let env: TestEnv;
  const schema = schemaName("m11_e2e_");

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
        const sqlText = await readMigrationSql(rel);
        await client.query(sqlText);
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
    env = await makeEnv(pool, db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.podcasts CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.notebooks CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.email_digests CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.markdown_digests CASCADE`);
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
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs`);
    await pool.query(`TRUNCATE TABLE ${schema}.discovery_events CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_lineage CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.prompt_versions CASCADE`);
  });

  afterAll(async () => {
    if (db) await closeKysely(db);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    if (pool) await closePool(pool);
  });

  async function seedEditionAtReady(env: TestEnv, editionDate: string) {
    const ed = await env.editionRepo.create(editionDate);

    const doc = await env.docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: `https://example.com/${editionDate}`,
      title: "Headline",
      publisher: "Example",
    });
    const sections = await env.sectionRepo.createBatch([
      {
        documentId: doc.id,
        order: 0,
        type: "paragraph",
        contentMarkdown: "Body about AI.",
        contentText: "Body about AI.",
      },
    ]);
    const chunks = await env.chunkRepo.createBatch([
      {
        id: `${doc.id}-c1`,
        documentId: doc.id,
        sectionId: sections[0]!.id,
        sequence: 0,
        text: "Body about AI.",
        tokenCount: 5,
        startOffset: 0,
        endOffset: 12,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    const chunkId = chunks[0]!.id;

    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await env.enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(
        ed.id,
        doc.id,
        t,
      );
    }

    await env.storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [{ label: "Headline story", documentIds: [doc.id] }],
    });
    const story = (await env.storyRepo.getByEdition(ed.id))[0]!;
    const prompt = await env.db
      .insertInto("prompt_versions")
      .values({ name: "story_summary", version: 1, template: "t", purpose: "t" })
      .returningAll()
      .executeTakeFirstOrThrow();
    await env.storySummaryRepo.replaceForStory({
      storyId: story.story.id,
      content: "Summary content.",
      promptId: prompt.id,
      promptVersion: prompt.version,
      model: "fake",
      provider: "fake",
      inputHash: "h",
      claims: [{ text: "A claim.", chunkId }],
    });

    const ready = await env.readinessGate.transitionToReadyIfReady(ed.id);
    expect(ready.transitioned).toBe(true);

    await env.markdownDigestRepo.createForEdition({
      editionId: ed.id,
      content: "# Daily Digest — " + editionDate + "\n\nSome content here.\n",
      storyCount: 1,
      documentCount: 1,
      citationCount: 1,
    });

    const now = new Date();
    await env.emailDigestRepo.createForEdition({
      editionId: ed.id,
      subject: "Daily Digest — " + editionDate,
      htmlContent: "<!doctype html><html><body>Daily</body></html>",
      textContent: "Daily",
      fromAddress: "from@example.com",
      toAddresses: ["to@example.com"],
      deliveryStatus: "sent",
      attemptCount: 1,
      providerMessageId: "msg-1",
      attemptedAt: now,
      completedAt: now,
    });

    const notebook = await env.notebookRepo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "ext-notebook-1",
      title: "Notebook",
      url: "https://notebooklm.example/abc",
      sourceCount: 1,
      status: "ready",
    });
    await env.notebookRepo.updateDelivery(notebook.id, {
      status: "ready",
      sourceCount: 1,
      completedAt: now,
    });

    const podcast = await env.podcastRepo.createForEdition({
      editionId: ed.id,
      notebookId: notebook.id,
      artifactExternalId: "ext-podcast-1",
      title: "Podcast",
      format: "mp3",
      language: "en",
      status: "ready",
      startedAt: now,
    });
    await env.podcastRepo.updateDelivery(podcast.id, {
      status: "ready",
      url: "https://podcasts.example/abc.mp3",
      completedAt: now,
    });

    return { ed, doc, chunkId, notebook, podcast };
  }

  async function seedSeparateEdition(env: TestEnv, editionDate: string) {
    return env.editionRepo.create(editionDate);
  }

  async function insertJob(
    editionId: string,
    status: "pending" | "running" | "completed" | "failed",
    jobType: string = "summarize_chunk",
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ${schema}.processing_jobs
        (id, job_type, edition_id, target, status, retry_count, last_error,
         next_eligible_at, created_at, updated_at, completed_at, depends_on)
      VALUES ($1, $2, $3, $4::jsonb, $5, 0, NULL,
              now(), now(), now(), ${status === "completed" ? "now()" : "NULL"}, '{}')`,
      [id, jobType, editionId, JSON.stringify({}), status],
    );
    return id;
  }

  itWithDb("publishes a Ready edition and cancels mutable jobs", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-07");
    const otherEdition = await seedSeparateEdition(env, "2026-07-08");

    for (let i = 0; i < 3; i++) await insertJob(ed.id, "pending", "summarize_chunk");
    for (let i = 0; i < 2; i++) await insertJob(ed.id, "running", "extract_entities");
    await insertJob(otherEdition.id, "pending", "summarize_chunk");
    const otherCompletedId = await insertJob(otherEdition.id, "completed", "summarize_chunk");

    const result = await env.service.publish({ editionId: ed.id });

    expect(result.status).toBe("published");
    expect(result.alreadyExisted).toBe(false);
    expect(result.cancelledJobCount).toBe(5);
    expect(result.completion.missingArtifacts).toEqual([]);
    expect(result.edition.id).toBe(ed.id);
    expect(result.edition.status).toBe("published");

    const editionRow = await pool.query(
      `SELECT status, published_at FROM ${schema}.editions WHERE id = $1`,
      [ed.id],
    );
    expect(editionRow.rows[0].status).toBe("published");
    expect(editionRow.rows[0].published_at).not.toBeNull();

    const cancelledRows = await pool.query(
      `SELECT status, last_error FROM ${schema}.processing_jobs
       WHERE edition_id = $1 AND status = 'failed'`,
      [ed.id],
    );
    expect(cancelledRows.rows.length).toBe(5);
    for (const row of cancelledRows.rows) {
      expect(row.last_error).toBeDefined();
      expect(row.last_error.type).toBe("JobCancelledError");
      expect(row.last_error.message).toContain(ed.id);
    }

    const otherRows = await pool.query(
      `SELECT id, status FROM ${schema}.processing_jobs WHERE edition_id = $1`,
      [otherEdition.id],
    );
    expect(otherRows.rows.length).toBe(2);
    for (const row of otherRows.rows) {
      if (row.id === otherCompletedId) {
        expect(row.status).toBe("completed");
      } else {
        expect(row.status).toBe("pending");
      }
    }
  });

  itWithDb("is idempotent on a Published edition", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-09");

    const first = await env.service.publish({ editionId: ed.id });
    expect(first.status).toBe("published");
    const firstPublishedAt = (await env.editionRepo.getById(ed.id))!.published_at;
    expect(firstPublishedAt).not.toBeNull();

    const second = await env.service.publish({ editionId: ed.id });
    expect(second.status).toBe("already_published");
    expect(second.alreadyExisted).toBe(true);
    expect(second.cancelledJobCount).toBe(0);
    expect(second.completion.missingArtifacts).toEqual([]);

    const afterPublishedAt = (await env.editionRepo.getById(ed.id))!.published_at;
    expect(afterPublishedAt!.getTime()).toBe(firstPublishedAt!.getTime());
  });

  itWithDb("is a no-op against a Publishing edition", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-10");
    await env.editionRepo.transition(ed.id, "publishing");

    const beforeRow = await pool.query(
      `SELECT status, published_at FROM ${schema}.editions WHERE id = $1`,
      [ed.id],
    );
    expect(beforeRow.rows[0].status).toBe("publishing");

    const result = await env.service.publish({ editionId: ed.id });
    expect(result.status).toBe("publishing");
    expect(result.alreadyExisted).toBe(false);
    expect(result.cancelledJobCount).toBe(0);
    expect(result.edition.status).toBe("publishing");

    const afterRow = await pool.query(
      `SELECT status, published_at FROM ${schema}.editions WHERE id = $1`,
      [ed.id],
    );
    expect(afterRow.rows[0].status).toBe("publishing");
    expect(afterRow.rows[0].published_at).toBeNull();
  });

  itWithDb("throws PublicationGateFailedError when markdown content is empty", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-11");
    await pool.query(
      `UPDATE ${schema}.markdown_digests SET content = '' WHERE edition_id = $1`,
      [ed.id],
    );

    await insertJob(ed.id, "pending", "summarize_chunk");
    await insertJob(ed.id, "running", "extract_entities");

    await expect(env.service.publish({ editionId: ed.id })).rejects.toBeInstanceOf(
      PublicationGateFailedError,
    );
    await expect(env.service.publish({ editionId: ed.id })).rejects.toThrow(
      /markdown digest missing or empty/,
    );

    const stillReady = await env.editionRepo.getById(ed.id);
    expect(stillReady!.status).toBe("ready");
    expect(stillReady!.published_at).toBeNull();

    const jobRows = await pool.query(
      `SELECT status FROM ${schema}.processing_jobs WHERE edition_id = $1`,
      [ed.id],
    );
    expect(jobRows.rows.length).toBe(2);
    for (const row of jobRows.rows) {
      expect(["pending", "running"]).toContain(row.status);
    }
  });

  itWithDb("throws PublicationGateFailedError when email is not sent", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-12");
    await pool.query(
      `UPDATE ${schema}.email_digests SET delivery_status = 'pending' WHERE edition_id = $1`,
      [ed.id],
    );

    let caught: unknown;
    try {
      await env.service.publish({ editionId: ed.id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PublicationGateFailedError);
    expect((caught as PublicationGateFailedError).missingArtifacts).toContain(
      "email not sent",
    );
    expect((caught as PublicationGateFailedError).editionId).toBe(ed.id);

    const stillReady = await env.editionRepo.getById(ed.id);
    expect(stillReady!.status).toBe("ready");
  });

  itWithDb("throws PublicationGateFailedError when podcast URL is null", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-13");
    await pool.query(
      `UPDATE ${schema}.podcasts SET url = NULL WHERE edition_id = $1`,
      [ed.id],
    );

    let caught: unknown;
    try {
      await env.service.publish({ editionId: ed.id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PublicationGateFailedError);
    expect((caught as PublicationGateFailedError).missingArtifacts).toContain(
      "podcast not ready or no URL",
    );

    const stillReady = await env.editionRepo.getById(ed.id);
    expect(stillReady!.status).toBe("ready");
  });
});