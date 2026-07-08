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
import { createEditionRepository } from "../editions/edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "../editions/enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "../editions/enrichment-gate-service.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createEditionAssemblyService } from "../editions/edition-assembly-service.js";
import { createEditionReadinessGate } from "../editions/edition-readiness-gate.js";
import { createTopicRepository } from "../enrichment/topics/topic-repository.js";
import { createMarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import { createMarkdownDigestService } from "../digest/markdown/markdown-digest-service.js";
import { createEmailDigestRepository } from "../digest/html/email-digest-repository.js";
import { createEmailDigestService } from "../digest/html/email-digest-service.js";
import { createResendClient, type ResendClient, type ResendEmailResult } from "../digest/html/resend-client.js";
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

interface CallRecord {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

interface FakeResendOptions {
  outcome: ResendEmailResult;
  captured?: CallRecord[];
}

function makeFakeResend(options: FakeResendOptions): ResendClient {
  return createResendClient({
    apiKey: "re_test",
    baseUrl: "https://api.resend.local",
    fetchImpl: (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const callRecord: CallRecord = { url, init: init ?? {} };
      options.captured?.push(callRecord);
      const r = options.outcome;
      if (r.ok) {
        return {
          status: r.status,
          ok: true,
          json: async () => r.raw,
          text: async () => (typeof r.raw === "string" ? r.raw : JSON.stringify(r.raw)),
        };
      }
      const body = r.errorBody || JSON.stringify(r.raw ?? {});
      return {
        status: r.status,
        ok: false,
        json: async () => r.raw ?? {},
        text: async () => body,
      };
    }) as never,
  });
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
  topicRepo: ReturnType<typeof createTopicRepository>;
  markdownDigestRepo: ReturnType<typeof createMarkdownDigestRepository>;
  markdownService: ReturnType<typeof createMarkdownDigestService>;
  emailDigestRepo: ReturnType<typeof createEmailDigestRepository>;
  captured: CallRecord[];
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
  const topicRepo = createTopicRepository(db);
  const markdownDigestRepo = createMarkdownDigestRepository(db);
  const markdownService = createMarkdownDigestService({
    db,
    editionRepo,
    assembly,
    storySummaryRepo,
    docRepo,
    chunkRepo,
    topicRepo,
    digestRepo: markdownDigestRepo,
    signalRepo: {
      createBatch: async () => [],
      getByEdition: async () => [],
      getByEditionAndKind: async () => [],
      countByEditionAndKind: async () => 0,
      getBySourceIdentity: async () => [],
    } as never,
    logger: silentLogger(),
  });
  const emailDigestRepo = createEmailDigestRepository(db);
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
    topicRepo,
    markdownDigestRepo,
    markdownService,
    emailDigestRepo,
    captured: [],
  };
}

describe("M8 end-to-end: markdown digest → HTML email → Resend", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let env: TestEnv;
  const schema = schemaName("m8_e2e_");

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
    env.captured.length = 0;
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
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs CASCADE`);
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

  async function seedReadyEdition(env: TestEnv, editionDate: string) {
    const ed = await env.editionRepo.create(editionDate);
    const doc = await env.docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: `https://example.com/${editionDate}`,
      title: "Headline",
      publisher: "Example",
    });
    const section = await env.sectionRepo.createBatch([
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
        sectionId: section[0]!.id,
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
      stories: [{ label: "OpenAI ships agent", documentIds: [doc.id] }],
    });
    const story = (await env.storyRepo.getByEdition(ed.id))[0]!;
    const prompt = await db
      .insertInto("prompt_versions")
      .values({ name: "story_summary", version: 1, template: "t", purpose: "t" })
      .returningAll()
      .executeTakeFirstOrThrow();
    await env.storySummaryRepo.replaceForStory({
      storyId: story.story.id,
      content: "OpenAI released an agent.",
      promptId: prompt.id,
      promptVersion: prompt.version,
      model: "fake",
      provider: "fake",
      inputHash: "h",
      claims: [{ text: "OpenAI released an agent.", chunkId }],
    });

    const ready = await env.readinessGate.transitionToReadyIfReady(ed.id);
    expect(ready.transitioned).toBe(true);
    return { ed };
  }

  function buildService(
    env: TestEnv,
    resend: ResendClient,
    config: { fromAddress: string; toAddresses: string[] } = {
      fromAddress: "Digest <from@example.com>",
      toAddresses: ["to@example.com"],
    },
  ) {
    return createEmailDigestService({
      db: env.db,
      editionRepo: env.editionRepo,
      markdownDigestRepo: env.markdownDigestRepo,
      emailDigestRepo: env.emailDigestRepo,
      resend,
      config,
      logger: silentLogger(),
    });
  }

  it("sends an email through the fake Resend client and persists the delivery record", async () => {
    const { ed } = await seedReadyEdition(env, "2026-07-07");
    const markdownResult = await env.markdownService.generate({ editionId: ed.id });
    expect(markdownResult.alreadyExisted).toBe(false);

    const resend = makeFakeResend({
      outcome: {
        ok: true,
        status: 200,
        messageId: "msg-abc",
        raw: { id: "msg-abc" },
      },
      captured: env.captured,
    });
    const svc = buildService(env, resend);

    const result = await svc.send({ editionId: ed.id });
    expect(result.deliveryStatus).toBe("sent");
    expect(result.providerMessageId).toBe("msg-abc");
    expect(result.alreadyExisted).toBe(false);
    expect(result.attempted).toBe(true);

    // Resend client was called once with the right shape.
    expect(env.captured.length).toBe(1);
    const call = env.captured[0]!;
    expect(call.url).toBe("https://api.resend.local/emails");
    const body = JSON.parse(call.init.body!);
    expect(body.from).toBe("Digest <from@example.com>");
    expect(body.to).toEqual(["to@example.com"]);
    expect(body.subject).toBe("Daily Digest — 2026-07-07");
    expect(body.html).toContain("<!doctype html>");
    expect(body.text).toContain("Daily Digest");
    expect(call.init.headers?.["Authorization"]).toBe("Bearer re_test");
    expect(call.init.headers?.["Idempotency-Key"]).toMatch(new RegExp(`^pnip:${ed.id}:`));

    // Persisted state.
    const persisted = await env.emailDigestRepo.getByEdition(ed.id);
    expect(persisted).toBeDefined();
    expect(persisted!.delivery_status).toBe("sent");
    expect(persisted!.provider_message_id).toBe("msg-abc");
    expect(persisted!.attempt_count).toBe(1);
    expect(persisted!.html_content).toContain("<!doctype html>");
    expect(persisted!.text_content).toContain("Daily Digest");
  });

  it("persists failure_reason and provider_response when Resend returns 422", async () => {
    const { ed } = await seedReadyEdition(env, "2026-07-08");
    await env.markdownService.generate({ editionId: ed.id });

    const resend = makeFakeResend({
      outcome: {
        ok: false,
        status: 422,
        errorBody: "validation failed",
        raw: { name: "validation_error", message: "validation failed" },
      },
      captured: env.captured,
    });
    const svc = buildService(env, resend);

    const result = await svc.send({ editionId: ed.id });
    expect(result.deliveryStatus).toBe("failed");
    expect(result.failureReason).toMatch(/HTTP 422/);
    expect(result.providerMessageId).toBeNull();

    const persisted = await env.emailDigestRepo.getByEdition(ed.id);
    expect(persisted!.delivery_status).toBe("failed");
    expect(persisted!.failure_reason).toMatch(/HTTP 422/);
  });

  it("re-running send is a no-op (idempotency §53)", async () => {
    const { ed } = await seedReadyEdition(env, "2026-07-09");
    await env.markdownService.generate({ editionId: ed.id });

    const resend = makeFakeResend({
      outcome: { ok: true, status: 200, messageId: "msg-1", raw: { id: "msg-1" } },
      captured: env.captured,
    });
    const svc = buildService(env, resend);
    const r1 = await svc.send({ editionId: ed.id });
    expect(r1.deliveryStatus).toBe("sent");
    expect(r1.alreadyExisted).toBe(false);

    const r2 = await svc.send({ editionId: ed.id });
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.attempted).toBe(false);
    expect(r2.emailDigestId).toBe(r1.emailDigestId);

    // Resend client was only called once across both sends.
    expect(env.captured.length).toBe(1);
  });

  it("fails cleanly when no recipients are configured", async () => {
    const { ed } = await seedReadyEdition(env, "2026-07-10");
    await env.markdownService.generate({ editionId: ed.id });

    const resend = makeFakeResend({
      outcome: { ok: true, status: 200, messageId: "x", raw: { id: "x" } },
      captured: env.captured,
    });
    const svc = buildService(env, resend, {
      fromAddress: "f@example.com",
      toAddresses: [],
    });
    const result = await svc.send({ editionId: ed.id });
    expect(result.deliveryStatus).toBe("failed");
    expect(result.failureReason).toMatch(/recipients/);
    expect(env.captured.length).toBe(0);
  });

  it("rejects when the markdown digest is missing", async () => {
    const ed = await env.editionRepo.create("2026-07-11");
    const resend = makeFakeResend({
      outcome: { ok: true, status: 200, messageId: "x", raw: { id: "x" } },
      captured: env.captured,
    });
    const svc = buildService(env, resend);
    await expect(svc.send({ editionId: ed.id })).rejects.toThrow(
      /no markdown digest/,
    );
  });
});
