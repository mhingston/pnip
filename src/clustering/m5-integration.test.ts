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
  createSummaryRepository,
  type SummaryRepository,
} from "../enrichment/summary/summary-repository.js";
import {
  createTopicRepository,
  type TopicRepository,
} from "../enrichment/topics/topic-repository.js";
import {
  createEmbeddingRepository,
  type EmbeddingRepository,
} from "../enrichment/embeddings/embedding-repository.js";
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
import { createClusterStoriesWorker } from "./cluster-stories-worker.js";
import { vectorToSql } from "../common/vector-codec.js";

const migrations = [
  "003_create_editions.sql",
  "004_create_prompt_versions.sql",
  "008_create_documents.sql",
  "009_create_document_sections.sql",
  "010_create_document_chunks.sql",
  "011_create_pgvector_extension.sql",
  "012_create_summaries.sql",
  "014_create_topics.sql",
  "016_create_embeddings.sql",
  "017_create_story_clusters.sql",
];

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

async function readMigrations(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of migrations) {
    const path = fileURLToPath(
      new URL(`../database/migrations/${m}`, import.meta.url),
    );
    out[m] = await readFile(path, "utf8");
  }
  return out;
}

function makeVector(seed: number, dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * 13.37 + i * 0.123) * 0.5;
  }
  return v;
}

describe("M5 Story Clustering end-to-end", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let sectionRepo: SectionRepository;
  let chunkRepo: ChunkRepository;
  let summaryRepo: SummaryRepository;
  let topicRepo: TopicRepository;
  let embeddingRepo: EmbeddingRepository;
  let promptRepo: PromptRepository;
  let storyRepo: StoryRepository;
  let storySummaryRepo: StorySummaryRepository;
  const schema = schemaName("m5_");
  let editionId: string;
  let doc1: string;
  let doc2: string;
  let doc3: string;
  let section1: string;
  let section2: string;
  let section3: string;
  let chunk1: string;
  let chunk2: string;
  let chunk3: string;
  let promptId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set");
    pool = createPool(url);

    const allMigrations = await readMigrations();
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const m of migrations) {
        await client.query(allMigrations[m]);
      }
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
    summaryRepo = createSummaryRepository(db);
    topicRepo = createTopicRepository(db);
    embeddingRepo = createEmbeddingRepository(db);
    promptRepo = createPromptRepository(db);
    storyRepo = createStoryRepository(db);
    storySummaryRepo = createStorySummaryRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-09-15") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;

    const d1 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/m5-1",
    });
    const d2 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/m5-2",
    });
    const d3 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/m5-3",
    });
    doc1 = d1.id;
    doc2 = d2.id;
    doc3 = d3.id;

    const s1 = await sectionRepo.createBatch([
      { documentId: doc1, order: 0, type: "title", contentText: "AI Title" },
    ]);
    const s2 = await sectionRepo.createBatch([
      { documentId: doc2, order: 0, type: "title", contentText: "Weather Title" },
    ]);
    const s3 = await sectionRepo.createBatch([
      { documentId: doc3, order: 0, type: "title", contentText: "AI Title 2" },
    ]);
    section1 = s1[0].id;
    section2 = s2[0].id;
    section3 = s3[0].id;

    const chunks = await chunkRepo.createBatch([
      {
        id: "m5-chunk-1",
        documentId: doc1,
        sectionId: section1,
        sequence: 0,
        text: "AI body",
        tokenCount: 2,
        startOffset: 0,
        endOffset: 7,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
      {
        id: "m5-chunk-2",
        documentId: doc2,
        sectionId: section2,
        sequence: 0,
        text: "Weather body",
        tokenCount: 2,
        startOffset: 0,
        endOffset: 12,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
      {
        id: "m5-chunk-3",
        documentId: doc3,
        sectionId: section3,
        sequence: 0,
        text: "AI body 2",
        tokenCount: 3,
        startOffset: 0,
        endOffset: 9,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
    chunk1 = chunks[0].id;
    chunk2 = chunks[1].id;
    chunk3 = chunks[2].id;

    const prompt = await promptRepo.createNewVersion({
      name: "summary",
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
    await db.deleteFrom("cluster_members").execute();
    await db.deleteFrom("story_clusters").execute();
    await db.deleteFrom("embeddings").execute();
    await db.deleteFrom("topic_assignments").execute();
    await db.deleteFrom("topics").execute();
    await db.deleteFrom("summary_citations").execute();
    await db.deleteFrom("summaries").execute();
  });

  function makeDeps() {
    return {
      docRepo,
      summaryRepo,
      topicRepo,
      embeddingRepo,
      storyRepo,
      provenanceRepo: {
        recordLineage: async () => undefined,
        recordLineageBatch: async () => undefined,
        getSources: async () => [],
        getConsumers: async () => [],
        resolveCitations: async () => [],
        resolveToDocuments: async () => [],
      } as any,
      signalRepo: {
        createBatch: async () => [],
        getByEdition: async () => [],
        getByEditionAndKind: async () => [],
        countByEditionAndKind: async () => 0,
        getBySourceIdentity: async () => [],
      } as any,
    };
  }

  function silentLogger() {
    return {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      child() {
        return this;
      },
    } as any;
  }

  async function seedDocument(
    documentId: string,
    chunkId: string,
    summaryContent: string,
    topics: { topic: string; confidence: number }[],
    embedding: number[],
  ) {
    const summary = await summaryRepo.replaceForChunk({
      chunkId,
      documentId,
      content: summaryContent,
      promptId,
      promptVersion: 1,
      model: "m",
      provider: "p",
      inputHash: `h-${documentId}`,
      claims: [{ text: "claim", chunkId }],
    });

    await db
      .insertInto("embeddings")
      .values({
        chunk_id: chunkId,
        vector: vectorToSql(embedding),
        model: "m",
        provider: "p",
        input_hash: `h-${documentId}`,
      })
      .execute();

    for (const t of topics) {
      const topic = await db
        .insertInto("topics")
        .values({
          chunk_id: chunkId,
          document_id: documentId,
          topic: t.topic,
          confidence: t.confidence,
          prompt_id: promptId,
          prompt_version: 1,
          model: "m",
          provider: "p",
          input_hash: `h-${documentId}`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto("topic_assignments")
        .values({
          topic_id: topic.id,
          chunk_id: chunkId,
          relevance: t.confidence,
        })
        .execute();
    }

    return summary;
  }

  it("groups 3 documents into stories based on embedding similarity and topics", async () => {
    const aiVec = makeVector(1, 384);
    const weatherVec = makeVector(99, 384);
    const ai2Vec = makeVector(1, 384);
    for (let i = 0; i < 384; i++) {
      ai2Vec[i] = aiVec[i] + Math.sin(i * 0.07) * 0.001;
    }

    await seedDocument(doc1, chunk1, "AI news.", [{ topic: "ai", confidence: 0.9 }], aiVec);
    await seedDocument(doc2, chunk2, "Weather news.", [{ topic: "weather", confidence: 0.9 }], weatherVec);
    await seedDocument(doc3, chunk3, "More AI.", [{ topic: "ai", confidence: 0.8 }], ai2Vec);

    const worker = createClusterStoriesWorker(makeDeps());
    const outcome = await worker.execute(
      {
        id: "job-1",
        job_type: "cluster_stories",
        edition_id: editionId,
        target: { editionId },
        status: "running",
        retry_count: 0,
        last_error: null,
        last_attempt_at: null,
        next_eligible_at: new Date(),
        locked_by: "w",
        locked_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        depends_on: [],
      } as any,
      { db: {} as any, logger: silentLogger() },
    );

    expect(outcome.childJobs).toBeDefined();
    expect(outcome.childJobs!.length).toBeGreaterThan(0);
    for (const cj of outcome.childJobs!) {
      expect(cj.jobType).toBe("summarize_story");
      expect(cj.editionId).toBe(editionId);
    }

    const stories = await storyRepo.getByEdition(editionId);
    expect(stories.length).toBeGreaterThanOrEqual(2);

    for (const s of stories) {
      const documentIds = s.members.map((m) => m.document_id);
      const unique = new Set(documentIds);
      expect(unique.size).toBe(documentIds.length);
    }

    for (const doc of [doc1, doc2, doc3]) {
      const found = await storyRepo.getStoryForDocument(doc);
      expect(found).toBeDefined();
      expect(found!.edition_id).toBe(editionId);
    }
  });

  it("places every document in exactly one story within the edition (invariant §32)", async () => {
    const aiVec = makeVector(2, 384);
    const ai2Vec = makeVector(2, 384);
    for (let i = 0; i < 384; i++) ai2Vec[i] = aiVec[i] * 0.99 + 0.001;

    await seedDocument(doc1, chunk1, "A", [{ topic: "tech", confidence: 0.9 }], aiVec);
    await seedDocument(doc2, chunk2, "B", [{ topic: "tech", confidence: 0.8 }], ai2Vec);
    await seedDocument(doc3, chunk3, "C", [{ topic: "tech", confidence: 0.7 }], aiVec);

    const worker = createClusterStoriesWorker(makeDeps());
    await worker.execute(
      {
        id: "job-1",
        job_type: "cluster_stories",
        edition_id: editionId,
        target: { editionId },
        status: "running",
        retry_count: 0,
        last_error: null,
        last_attempt_at: null,
        next_eligible_at: new Date(),
        locked_by: "w",
        locked_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        depends_on: [],
      } as any,
      { db: {} as any, logger: silentLogger() },
    );

    const all = await storyRepo.getByEdition(editionId);
    const docIdsByStory = new Map<string, string>();
    for (const s of all) {
      for (const m of s.members) {
        expect(docIdsByStory.has(m.document_id)).toBe(false);
        docIdsByStory.set(m.document_id, s.story.id);
      }
    }
    expect(docIdsByStory.size).toBe(3);
  });

  it("does not modify document-level enrichments (invariant §52)", async () => {
    const aiVec = makeVector(3, 384);
    const wVec = makeVector(50, 384);

    await seedDocument(doc1, chunk1, "X", [{ topic: "ai", confidence: 0.9 }], aiVec);
    await seedDocument(doc2, chunk2, "Y", [{ topic: "weather", confidence: 0.9 }], wVec);

    const summariesBefore = await db
      .selectFrom("summaries")
      .selectAll()
      .orderBy("id")
      .execute();
    const topicsBefore = await db.selectFrom("topics").selectAll().orderBy("id").execute();
    const embeddingsBefore = await db
      .selectFrom("embeddings")
      .selectAll()
      .orderBy("id")
      .execute();

    const worker = createClusterStoriesWorker(makeDeps());
    await worker.execute(
      {
        id: "job-1",
        job_type: "cluster_stories",
        edition_id: editionId,
        target: { editionId },
        status: "running",
        retry_count: 0,
        last_error: null,
        last_attempt_at: null,
        next_eligible_at: new Date(),
        locked_by: "w",
        locked_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        depends_on: [],
      } as any,
      { db: {} as any, logger: silentLogger() },
    );

    const summariesAfter = await db
      .selectFrom("summaries")
      .selectAll()
      .orderBy("id")
      .execute();
    const topicsAfter = await db.selectFrom("topics").selectAll().orderBy("id").execute();
    const embeddingsAfter = await db
      .selectFrom("embeddings")
      .selectAll()
      .orderBy("id")
      .execute();

    expect(summariesAfter).toEqual(summariesBefore);
    expect(topicsAfter).toEqual(topicsBefore);
    expect(embeddingsAfter).toEqual(embeddingsBefore);
  });

  it("re-running the worker produces deterministic story labels and membership", async () => {
    const v1 = makeVector(7, 384);
    const v2 = makeVector(99, 384);
    await seedDocument(doc1, chunk1, "Alpha", [{ topic: "ai", confidence: 0.9 }], v1);
    await seedDocument(doc2, chunk2, "Beta", [{ topic: "weather", confidence: 0.9 }], v2);

    const worker = createClusterStoriesWorker(makeDeps());
    const job = {
      id: "job-1",
      job_type: "cluster_stories",
      edition_id: editionId,
      target: { editionId },
      status: "running",
      retry_count: 0,
      last_error: null,
      last_attempt_at: null,
      next_eligible_at: new Date(),
      locked_by: "w",
      locked_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      depends_on: [],
    } as any;

    await worker.execute(job, { db: {} as any, logger: silentLogger() });
    const first = await storyRepo.getByEdition(editionId);
    await worker.execute(job, { db: {} as any, logger: silentLogger() });
    const second = await storyRepo.getByEdition(editionId);

    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(second[i].story.label).toBe(first[i].story.label);
      expect(
        second[i].members.map((m) => m.document_id).sort(),
      ).toEqual(first[i].members.map((m) => m.document_id).sort());
    }
  });

  it("determinism audit: 3 docs with overlapping topics produce identical story labels + clusters across reruns", async () => {
    // Pre-fix, `pickRepresentativeTopic` used `Math.random()` to choose
    // among multiple topics, so each run produced a different label.
    // Post-fix, the lexical-first tiebreak + the secondary `source_url`
    // sort on `document_repository.getByEdition` make every run byte-identical.

    // vAlpha and vBeta are similar (same sin seed family) so they cluster
    // together under threshold 0.5; vGamma is unrelated. Each cluster
    // gets THREE competing topics so the clusterer must pick one to
    // label the cluster. Pre-fix this was random; post-fix it must
    // always pick the lexicographically smallest topic per cluster.

    const vAlpha = makeVector(7, 384);
    const vBeta = makeVector(8, 384);
    const vGamma = makeVector(99, 384);

    await seedDocument(doc1, chunk1, "Alpha", [
      { topic: "tech", confidence: 0.7 },
      { topic: "ml", confidence: 0.9 },
      { topic: "ai", confidence: 0.5 },
    ], vAlpha);
    await seedDocument(doc2, chunk2, "Beta", [
      { topic: "ai", confidence: 0.95 },
      { topic: "ml", confidence: 0.6 },
      { topic: "tech", confidence: 0.4 },
    ], vBeta);
    await seedDocument(doc3, chunk3, "Gamma", [
      { topic: "policy", confidence: 0.95 },
      { topic: "regulation", confidence: 0.6 },
      { topic: "ai", confidence: 0.4 },
    ], vGamma);

    const worker = createClusterStoriesWorker(makeDeps());
    const job = {
      id: "job-det",
      job_type: "cluster_stories",
      edition_id: editionId,
      target: { editionId },
      status: "running",
      retry_count: 0,
      last_error: null,
      last_attempt_at: null,
      next_eligible_at: new Date(),
      locked_by: "w",
      locked_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      depends_on: [],
    } as any;

    const runs: {
      labels: string[];
      membersByLabel: Record<string, string[]>;
    }[] = [];
    for (let run = 0; run < 6; run++) {
      await worker.execute(job, { db: {} as any, logger: silentLogger() });
      const stories = await storyRepo.getByEdition(editionId);
      runs.push({
        labels: stories.map((s) => s.story.label),
        membersByLabel: Object.fromEntries(
          stories.map((s) => [
            s.story.label,
            s.members.map((m) => m.document_id).sort(),
          ]),
        ),
      });
    }

    // All 6 runs must produce the same labels in the same order, with
    // the same member sets. Pre-fix this would have produced differing
    // `story-ml-1` vs `story-tech-1` labels across runs because each
    // run independently rolled `Math.random()` per cluster.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.labels).toEqual(runs[0]!.labels);
      expect(runs[i]!.membersByLabel).toEqual(runs[0]!.membersByLabel);
    }

    // Additionally: the labels must START with the lexically smallest
    // topic ('ai') since both clusters have 'ai' as one of their 3 topics.
    expect(runs[0]!.labels[0]).toMatch(/^story-ai-/);
  });

  it("story summary citations reference real chunks (provenance integrity)", async () => {
    const v = makeVector(11, 384);
    await seedDocument(doc1, chunk1, "A", [{ topic: "ai", confidence: 0.9 }], v);
    await seedDocument(doc3, chunk3, "B", [{ topic: "ai", confidence: 0.8 }], v);

    const worker = createClusterStoriesWorker(makeDeps());
    await worker.execute(
      {
        id: "job-1",
        job_type: "cluster_stories",
        edition_id: editionId,
        target: { editionId },
        status: "running",
        retry_count: 0,
        last_error: null,
        last_attempt_at: null,
        next_eligible_at: new Date(),
        locked_by: "w",
        locked_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        depends_on: [],
      } as any,
      { db: {} as any, logger: silentLogger() },
    );

    const stories = await storyRepo.getByEdition(editionId);
    const story = stories[0];
    expect(story.members.length).toBeGreaterThanOrEqual(1);

    const fakeCitation = await db
      .insertInto("story_summaries")
      .values({
        story_id: story.story.id,
        content: "Test summary.",
        prompt_id: promptId,
        prompt_version: 1,
        model: "m",
        provider: "p",
        input_hash: "h",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (let i = 0; i < story.members.length; i++) {
      const member = story.members[i];
      await db
        .insertInto("story_summary_citations")
        .values({
          story_summary_id: fakeCitation.id,
          chunk_id: member.document_id === doc1 ? chunk1 : chunk3,
          claim_text: "claim",
          claim_order: i,
        })
        .execute();
    }

    const cits = await storySummaryRepo.getCitationsBySummaryId(fakeCitation.id);
    expect(cits).toHaveLength(story.members.length);
    for (const c of cits) {
      expect([chunk1, chunk2, chunk3]).toContain(c.chunk_id);
    }
  });
});
