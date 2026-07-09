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
import { createTopicRepository } from "../enrichment/topics/topic-repository.js";
import { createMarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import { createMarkdownDigestService } from "../digest/markdown/markdown-digest-service.js";
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
  digestRepo: ReturnType<typeof createMarkdownDigestRepository>;
  service: ReturnType<typeof createMarkdownDigestService>;
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
  const digestRepo = createMarkdownDigestRepository(db);
  const service = createMarkdownDigestService({
    db,
    editionRepo,
    assembly,
    storySummaryRepo,
    docRepo,
    chunkRepo,
    topicRepo,
    digestRepo,
    signalRepo: {
      createBatch: async () => [],
      getByEdition: async () => [],
      getByEditionAndKind: async () => [],
      countByEditionAndKind: async () => 0,
      getBySourceIdentity: async () => [],
    } as never,
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
    topicRepo,
    digestRepo,
    service,
  };
}

describe("M7 end-to-end: deterministic markdown digest from ready edition", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let env: TestEnv;
  const schema = schemaName("m7_e2e_");

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

  async function makeDoc(
    env: TestEnv,
    editionId: string,
    sourceUrl: string,
    options: {
      sourceType?: string;
      title?: string;
      publisher?: string;
      bodyText?: string;
    } = {},
  ) {
    const doc = await env.docRepo.create({
      editionId,
      sourceType: options.sourceType ?? "article",
      sourceUrl,
      title: options.title,
      publisher: options.publisher,
    });
    await env.sectionRepo.createBatch([
      {
        documentId: doc.id,
        order: 0,
        type: "paragraph",
        contentMarkdown: options.bodyText ?? "Some body text.",
        contentText: options.bodyText ?? "Some body text.",
      },
    ]);
    const chunks = await env.chunkRepo.createBatch([
      {
        id: `${doc.id}-c1`,
        documentId: doc.id,
        sectionId: (await env.sectionRepo.getByDocumentId(doc.id))[0]!.id,
        sequence: 0,
        text: options.bodyText ?? "Some body text.",
        tokenCount: 5,
        startOffset: 0,
        endOffset: 16,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    return { doc, chunkId: chunks[0]!.id };
  }

  async function seedEditionAtReady(env: TestEnv, editionDate: string) {
    const ed = await env.editionRepo.create(editionDate);
    const techDoc = await makeDoc(env, ed.id, "https://example.com/ai", {
      sourceType: "article",
      title: "OpenAI ships new agent",
      publisher: "Example",
      bodyText: "Body about AI.",
    });
    const politicsDoc = await makeDoc(env, ed.id, "https://example.com/senate", {
      sourceType: "article",
      title: "Senate Vote",
      publisher: "Example",
      bodyText: "Body about politics.",
    });
    const videoDoc = await makeDoc(env, ed.id, "https://example.com/yt", {
      sourceType: "youtube",
      title: "Cat video",
      publisher: "YouTube",
      bodyText: "Video description.",
    });
    const redditDoc = await makeDoc(env, ed.id, "https://example.com/reddit", {
      sourceType: "reddit",
      title: "Reddit thread about it",
      publisher: "Reddit",
      bodyText: "Reddit discussion.",
    });
    const interestingDoc = await makeDoc(env, ed.id, "https://example.com/odd", {
      sourceType: "article",
      title: "Small town festival",
      publisher: "Example",
      bodyText: "Interesting reads.",
    });
    const scienceDoc = await makeDoc(env, ed.id, "https://example.com/science", {
      sourceType: "article",
      title: "New astronomy research",
      publisher: "Example",
      bodyText: "Body about science.",
    });
    const businessDoc = await makeDoc(env, ed.id, "https://example.com/business", {
      sourceType: "article",
      title: "Startup raises Series B funding",
      publisher: "Example",
      bodyText: "Body about business.",
    });
    // Extra Technology / Politics docs so they overflow the top-5 cut and
    // exercise the category sections.
    const techDoc2 = await makeDoc(env, ed.id, "https://example.com/ai2", {
      sourceType: "article",
      title: "Anthropic releases a Claude update",
      publisher: "Example",
      bodyText: "Body about AI.",
    });
    const techDoc3 = await makeDoc(env, ed.id, "https://example.com/ai3", {
      sourceType: "article",
      title: "Gemini benchmarks improve",
      publisher: "Example",
      bodyText: "Body about AI.",
    });
    const politicsDoc2 = await makeDoc(env, ed.id, "https://example.com/senate2", {
      sourceType: "article",
      title: "Congress passes regulation",
      publisher: "Example",
      bodyText: "Body about politics.",
    });
    const videoDoc2 = await makeDoc(env, ed.id, "https://example.com/yt2", {
      sourceType: "youtube",
      title: "Another video",
      publisher: "YouTube",
      bodyText: "Video description 2.",
    });
    const redditDoc2 = await makeDoc(env, ed.id, "https://example.com/reddit2", {
      sourceType: "reddit",
      title: "Another reddit thread",
      publisher: "Reddit",
      bodyText: "Reddit discussion 2.",
    });

    const allDocs = [
      techDoc,
      politicsDoc,
      videoDoc,
      redditDoc,
      interestingDoc,
      scienceDoc,
      businessDoc,
      techDoc2,
      techDoc3,
      politicsDoc2,
      videoDoc2,
      redditDoc2,
    ];

    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      for (const docWrap of allDocs) {
        await env.enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(
          ed.id,
          docWrap.doc.id,
          t,
        );
      }
    }

    await env.storyRepo.replaceForEdition({
      editionId: ed.id,
      stories: [
        { label: "OpenAI ships new agent", documentIds: [techDoc.doc.id] },
        { label: "Senate Vote Recap", documentIds: [politicsDoc.doc.id] },
        { label: "Cat video", documentIds: [videoDoc.doc.id] },
        { label: "Reddit thread about it", documentIds: [redditDoc.doc.id] },
        { label: "Small town festival", documentIds: [interestingDoc.doc.id] },
        { label: "New astronomy research", documentIds: [scienceDoc.doc.id] },
        { label: "Startup raises Series B", documentIds: [businessDoc.doc.id] },
        { label: "Anthropic releases a Claude update", documentIds: [techDoc2.doc.id] },
        { label: "Gemini benchmarks improve", documentIds: [techDoc3.doc.id] },
        { label: "Congress passes regulation", documentIds: [politicsDoc2.doc.id] },
        { label: "Another video", documentIds: [videoDoc2.doc.id] },
        { label: "Another reddit thread", documentIds: [redditDoc2.doc.id] },
      ],
    });

    const allStories = await env.storyRepo.getByEdition(ed.id);
    const prompt = await db
      .insertInto("prompt_versions")
      .values({
        name: "story_summary",
        version: 1,
        template: "t",
        purpose: "t",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const seedTexts: Record<string, { content: string; claim: string }> = {
      [techDoc.doc.id]: {
        content: "OpenAI released an agent. It does X and Y.",
        claim: "OpenAI released an agent.",
      },
      [politicsDoc.doc.id]: {
        content: "The Senate held a vote. The vote passed.",
        claim: "The Senate held a vote.",
      },
      [videoDoc.doc.id]: {
        content: "A cat video went viral.",
        claim: "A cat video went viral.",
      },
      [redditDoc.doc.id]: {
        content: "Reddit users discussed implications.",
        claim: "Reddit users discussed implications.",
      },
      [interestingDoc.doc.id]: {
        content: "A small town held an odd festival.",
        claim: "A small town held an odd festival.",
      },
      [scienceDoc.doc.id]: {
        content: "Researchers published a new astronomy finding.",
        claim: "Researchers published a new astronomy finding.",
      },
      [businessDoc.doc.id]: {
        content: "A startup raised Series B funding.",
        claim: "A startup raised Series B funding.",
      },
      [techDoc2.doc.id]: {
        content: "Anthropic released a Claude update.",
        claim: "Anthropic released a Claude update.",
      },
      [techDoc3.doc.id]: {
        content: "Gemini benchmarks improved.",
        claim: "Gemini benchmarks improved.",
      },
      [politicsDoc2.doc.id]: {
        content: "Congress passed a regulation.",
        claim: "Congress passed a regulation.",
      },
      [videoDoc2.doc.id]: {
        content: "Another video description.",
        claim: "Another video is interesting.",
      },
      [redditDoc2.doc.id]: {
        content: "Another reddit discussion.",
        claim: "Another reddit thread is interesting.",
      },
    };
    const chunksByDocId: Record<string, string> = {};
    for (const docWrap of allDocs) chunksByDocId[docWrap.doc.id] = docWrap.chunkId;

    for (const s of allStories) {
      const memberDocId = s.members[0]!.document_id;
      const seed = seedTexts[memberDocId]!;
      const chunkId = chunksByDocId[memberDocId]!;
      await env.storySummaryRepo.replaceForStory({
        storyId: s.story.id,
        content: seed.content,
        promptId: prompt.id,
        promptVersion: prompt.version,
        model: "fake",
        provider: "fake",
        inputHash: `h-${memberDocId}`,
        claims: [{ text: seed.claim, chunkId }],
      });
    }

    const ready = await env.readinessGate.transitionToReadyIfReady(ed.id);
    expect(ready.transitioned).toBe(true);
    return {
      ed,
      techDoc,
      politicsDoc,
      videoDoc,
      redditDoc,
      interestingDoc,
      scienceDoc,
      businessDoc,
      techDoc2,
      techDoc3,
      politicsDoc2,
      videoDoc2,
      redditDoc2,
    };
  }

  it("generates a deterministic Markdown digest for a Ready edition", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-07");

    const r1 = await env.service.generate({ editionId: ed.id });
    expect(r1.alreadyExisted).toBe(false);
    expect(r1.storyCount).toBe(12);
    expect(r1.documentCount).toBe(12);
    expect(r1.citationCount).toBeGreaterThan(0);

    const fromRepo = await env.digestRepo.getByEdition(ed.id);
    expect(fromRepo).toBeDefined();
    expect(fromRepo!.content).not.toContain("## Executive Summary");
    expect(fromRepo!.content).toContain("## Top Stories");
    expect(fromRepo!.content).toContain("## Sources");
    expect(fromRepo!.content).toMatch(/## Technology/);
    expect(fromRepo!.content).toMatch(/## Politics/);
    expect(fromRepo!.content).toMatch(/## Science/);
    expect(fromRepo!.content).toMatch(/## Business/);
    expect(fromRepo!.content).toMatch(/## Videos/);
    expect(fromRepo!.content).toMatch(/## Reddit Discussions/);
    expect(fromRepo!.content).toMatch(/\[1\]/);

    // Second call is a no-op (idempotency per §53).
    const r2 = await env.service.generate({ editionId: ed.id });
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.digestId).toBe(r1.digestId);

    const afterSecond = await env.digestRepo.getByEdition(ed.id);
    expect(afterSecond!.content).toBe(fromRepo!.content);
    expect(afterSecond!.created_at.getTime()).toBe(fromRepo!.created_at.getTime());
  });

  it("renders identical Markdown for the same input (determinism §43)", async () => {
    const { ed } = await seedEditionAtReady(env, "2026-07-08");
    await env.service.generate({ editionId: ed.id });
    const first = (await env.digestRepo.getByEdition(ed.id))!.content;

    // Mutate downstream noise (created_at touch) — content must not change.
    await pool.query(
      `UPDATE ${schema}.markdown_digests SET created_at = now() - interval '1 hour'`,
    );
    await env.service.generate({ editionId: ed.id });
    const second = (await env.digestRepo.getByEdition(ed.id))!.content;
    expect(second).toBe(first);
  });

  it("surfaces a useful error when the edition has no stories", async () => {
    const ed = await env.editionRepo.create("2026-07-09");
    await expect(env.service.generate({ editionId: ed.id })).rejects.toThrow();
  });

  it("rejects an unknown edition id", async () => {
    await expect(
      env.service.generate({ editionId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/edition not found/);
  });
});
