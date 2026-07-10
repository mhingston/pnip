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
  createEditionRepository,
  InvalidEditionTransitionError,
} from "./edition-repository.js";
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
import { createSummaryRepository } from "../enrichment/summary/summary-repository.js";
import { createEntityRepository } from "../enrichment/entities/entity-repository.js";
import { createQualityRepository } from "../enrichment/quality/quality-repository.js";
import { createEmbeddingRepository } from "../enrichment/embeddings/embedding-repository.js";
import { createPromptRepository } from "../prompts/prompt-repository.js";
import { createFakeProvider } from "../ai/fake-provider.js";
import { createFakeEmbeddingProvider } from "../ai/fake-embedding-provider.js";
import { createPromptExecutionService } from "../ai/prompt-execution.js";
import { createProvenanceRepository } from "../provenance/provenance-repository.js";
import { createMarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import { createMarkdownDigestService } from "../digest/markdown/markdown-digest-service.js";
import { createEmailDigestRepository } from "../digest/html/email-digest-repository.js";
import { createEmailDigestService } from "../digest/html/email-digest-service.js";
import {
  createResendClient,
  type ResendClient,
  type ResendEmailResult,
} from "../digest/html/resend-client.js";
import { createNotebookRepository } from "../digest/notebooklm/notebook-repository.js";
import { createPodcastRepository } from "../digest/notebooklm/podcast-repository.js";
import { createNotebookService } from "../digest/notebooklm/notebook-service.js";
import { createPodcastService } from "../digest/notebooklm/podcast-service.js";
import { createDiscoveryRepository } from "../discovery/discovery-repository.js";
import { createDiscoveryService } from "../discovery/discovery-service.js";
import {
  createProcessingJobQueue,
  type ProcessingJobQueue,
} from "../jobs/queue/processing-job-queue.js";
import {
  createPublicationService,
  type PublicationService,
} from "../publication/publication-service.js";
import { createSignalRepository } from "../signals/signal-repository.js";
import { createSourceTrustRepository } from "../signals/source-trust-repository.js";
import { runFeedbackHide, runFeedbackRate } from "../cli/feedback.js";
import { getBiasView } from "../signals/bias-view.js";
import { createExpandDocumentWorker } from "../expansion/expand-document-worker.js";
import { createChunkDocumentWorker } from "../chunking/chunk-document-worker.js";
import { createClusterStoriesWorker } from "../clustering/cluster-stories-worker.js";
import { createSummarizeStoryWorker } from "../clustering/summarize-story-worker.js";
import { createSummarizeChunkWorker } from "../enrichment/summary/summarize-chunk-worker.js";
import { createExtractEntitiesWorker } from "../enrichment/entities/extract-entities-worker.js";
import { createAssignTopicsWorker } from "../enrichment/topics/assign-topics-worker.js";
import { createClassifyQualityWorker } from "../enrichment/quality/classify-quality-worker.js";
import { createEmbedChunkWorker } from "../enrichment/embeddings/embed-chunk-worker.js";
import { createPluginRegistry } from "../expansion/plugin-registry.js";
import { createArticlePlugin } from "../expansion/article-plugin.js";
import { createYouTubePlugin } from "../expansion/youtube-plugin.js";
import {
  createWorkerRuntime,
  type WorkerRuntime,
} from "../jobs/workers/worker-runtime.js";
import type { Worker } from "../jobs/workers/worker.js";
import {
  seedDefaultPrompts,
} from "../prompts/seed-default-prompts.js";
import type {
  MinifluxClient,
  MinifluxEntry,
} from "../discovery/miniflux-client.js";
import type {
  NotebookLmClient,
} from "../digest/notebooklm/notebooklm-client.js";
import type {
  AiProvider,
} from "../ai/provider.js";
import type {
  EmbeddingProvider,
} from "../ai/embedding-provider.js";
import type { ProcessingJob } from "../database/kysely.js";
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
  "../database/migrations/024_create_signals.sql",
  "../database/migrations/025_create_source_trust.sql",
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

interface ResendCallRecord {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeFakeResend(opts: {
  outcome: ResendEmailResult;
  captured?: ResendCallRecord[];
}): ResendClient {
  return createResendClient({
    apiKey: "re_test",
    baseUrl: "https://api.resend.local",
    fetchImpl: (async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const record: ResendCallRecord = { url, init: init ?? {} };
      opts.captured?.push(record);
      const r = opts.outcome;
      if (r.ok) {
        return {
          status: r.status,
          ok: true,
          json: async () => r.raw,
          text: async () =>
            typeof r.raw === "string" ? r.raw : JSON.stringify(r.raw),
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

interface FakeMinifluxCalls {
  listUnread: Array<{ limit?: number; afterEntryId?: number }>;
  markEntryRead: number[];
}

function makeFakeMiniflux(opts: {
  pages: MinifluxEntry[][];
}): { client: MinifluxClient; calls: FakeMinifluxCalls } {
  const calls: FakeMinifluxCalls = { listUnread: [], markEntryRead: [] };
  let pageIndex = 0;
  const client: MinifluxClient = {
    async listUnreadEntries(
      listOpts?: { limit?: number; afterEntryId?: number },
    ): Promise<MinifluxEntry[]> {
      calls.listUnread.push({
        limit: listOpts?.limit,
        afterEntryId: listOpts?.afterEntryId,
      });
      const page = opts.pages[pageIndex] ?? [];
      pageIndex += 1;
      return page;
    },
    async markEntryRead(id: number): Promise<void> {
      calls.markEntryRead.push(id);
    },
    async markEntriesRead(ids: number[]): Promise<void> {
      for (const id of ids) calls.markEntryRead.push(id);
    },
    async health() {
      return { ok: true, status: 200 };
    },
  };
  return { client, calls };
}

function makeFakeNotebookLm(): NotebookLmClient {
  let notebookSeq = 0;
  let sourceSeq = 0;
  let taskSeq = 0;
  return {
    async createNotebook(input) {
      notebookSeq += 1;
      const id = `nb-${notebookSeq}`;
      return {
        notebookExternalId: id,
        title: input.title,
        url: `https://notebooklm.google.com/notebook/${id}`,
        createdAt: new Date().toISOString(),
      };
    },
    async addSource(input) {
      sourceSeq += 1;
      return {
        sourceExternalId: `src-${sourceSeq}`,
        title: input.displayName ?? null,
        kind: input.url ? "url" : input.filePath ? "file" : "text",
        url: input.url ?? null,
        status: "ready",
      };
    },
    async waitForSource() {
      return { status: "ready", attempts: 1 };
    },
    async generateAudio(input) {
      taskSeq += 1;
      const taskId = `task-${taskSeq}`;
      const url = input.wait
        ? `https://notebooklm.google.com/audio/${taskId}.mp3`
        : null;
      return { taskId, status: input.wait ? "completed" : "pending", url };
    },
    async waitForArtifact() {
      return {
        status: "completed",
        url: "https://notebooklm.google.com/audio/artifact.mp3",
        attempts: 1,
      };
    },
    async downloadAudio(input) {
      return { destinationPath: input.destinationPath, bytes: 0 };
    },
    async authCheck() {
      return { ok: true, details: { status: "ok" } };
    },
    async listNotebooks() {
      return [];
    },
  };
}

function makeArticleContent(seed: number): string {
  return [
    `Title: AI Article ${seed}`,
    `URL Source: https://example.com/articles/${seed}`,
    `Published Time: 2026-07-${String(seed).padStart(2, "0")}`,
    "",
    `Markdown Content:`,
    "",
    `# AI Article ${seed}`,
    "",
    `OpenAI released a new agent framework that improves developer productivity across the software industry.`,
    "",
    `The release includes new tooling, an updated API, and integration with popular programming languages.`,
    "",
    `Industry observers expect broad adoption within months.`,
  ].join("\n");
}

function makeYouTubeContent(seed: number): {
  raw: string;
  meta: { title: string; author_name: string };
} {
  const raw = [
    `[00:00:00] Welcome to our deep dive on the latest AI news from this week.`,
    `[00:00:30] Today we cover the new OpenAI agent framework and what it means for developers.`,
    `[00:01:00] We also discuss the Gemini benchmark improvements released this morning.`,
    `[00:01:30] Stick around for an interview with the lead engineer on the project.`,
  ].join("\n");
  return {
    raw,
    meta: {
      title: `YouTube Video ${seed}`,
      author_name: `Channel ${seed}`,
    },
  };
}

function fakeAiText(prompt: string): string {
  if (prompt.includes("summarising a single chunk")) {
    return JSON.stringify({
      summary: "Chunk summary text.",
      claims: ["Chunk claim one.", "Chunk claim two."],
    });
  }
  if (prompt.includes("extracting named entities")) {
    return JSON.stringify({
      entities: [
        { name: "OpenAI", type: "organization", mention: "OpenAI" },
        { name: "Gemini", type: "product", mention: "Gemini" },
      ],
    });
  }
  if (prompt.includes("assigning topics")) {
    return JSON.stringify({
      topics: [
        { topic: "ai", confidence: 0.95, relevance: 0.9 },
        { topic: "developer tools", confidence: 0.7, relevance: 0.6 },
      ],
    });
  }
  if (prompt.includes("classifying the quality")) {
    return JSON.stringify({
      label: "high",
      confidence: 0.9,
      reasoning: "Clear and substantive.",
    });
  }
  if (prompt.includes("master summary of a news story")) {
    return JSON.stringify({
      summary: "Story summary text combining source documents.",
      claims: [
        "Story claim referencing chunk one [chunk 1].",
        "Another claim also from chunk one [chunk 1].",
      ],
    });
  }
  return "FAKE";
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
  summaryRepo: ReturnType<typeof createSummaryRepository>;
  entityRepo: ReturnType<typeof createEntityRepository>;
  qualityRepo: ReturnType<typeof createQualityRepository>;
  embeddingRepo: ReturnType<typeof createEmbeddingRepository>;
  promptRepo: ReturnType<typeof createPromptRepository>;
  provenanceRepo: ReturnType<typeof createProvenanceRepository>;
  markdownDigestRepo: ReturnType<typeof createMarkdownDigestRepository>;
  markdownService: ReturnType<typeof createMarkdownDigestService>;
  emailDigestRepo: ReturnType<typeof createEmailDigestRepository>;
  notebookRepo: ReturnType<typeof createNotebookRepository>;
  podcastRepo: ReturnType<typeof createPodcastRepository>;
  jobQueue: ProcessingJobQueue;
  discoveryRepo: ReturnType<typeof createDiscoveryRepository>;
  pluginRegistry: ReturnType<typeof createPluginRegistry>;
  provider: AiProvider;
  embeddingProvider: EmbeddingProvider;
  promptExecutor: ReturnType<typeof createPromptExecutionService>;
  publishService: ReturnType<typeof createPublicationService>;
  signalRepo: ReturnType<typeof createSignalRepository>;
  sourceTrustRepo: ReturnType<typeof createSourceTrustRepository>;
  captured: ResendCallRecord[];
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
  const summaryRepo = createSummaryRepository(db);
  const entityRepo = createEntityRepository(db);
  const qualityRepo = createQualityRepository(db);
  const embeddingRepo = createEmbeddingRepository(db);
  const promptRepo = createPromptRepository(db);
  const provenanceRepo = createProvenanceRepository(db);
  const markdownDigestRepo = createMarkdownDigestRepository(db);
  const signalRepo = createSignalRepository(db);
  const sourceTrustRepo = createSourceTrustRepository(db);
  const markdownService = createMarkdownDigestService({
    db,
    editionRepo,
    assembly,
    storySummaryRepo,
    docRepo,
    chunkRepo,
    topicRepo,
    digestRepo: markdownDigestRepo,
    signalRepo,
    logger: silentLogger(),
  });
  const emailDigestRepo = createEmailDigestRepository(db);
  const notebookRepo = createNotebookRepository(db);
  const podcastRepo = createPodcastRepository(db);
  const jobQueue = createProcessingJobQueue(db);
  const discoveryRepo = createDiscoveryRepository(db);
  const pluginRegistry = createPluginRegistry();
  const provider = createFakeProvider({ text: fakeAiText });
  const embeddingProvider = createFakeEmbeddingProvider({ dimension: 384 });
  const promptExecutor = createPromptExecutionService();
  const captured: ResendCallRecord[] = [];
  const publishService = createPublicationService({
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
    topicRepo,
    summaryRepo,
    entityRepo,
    qualityRepo,
    embeddingRepo,
    promptRepo,
    provenanceRepo,
    markdownDigestRepo,
    markdownService,
    emailDigestRepo,
    notebookRepo,
    podcastRepo,
    jobQueue,
    discoveryRepo,
    pluginRegistry,
    provider,
    embeddingProvider,
    promptExecutor,
    publishService,
    signalRepo,
    sourceTrustRepo,
    captured,
  };
}

function makeProcessingJob(
  overrides: Partial<ProcessingJob> & {
    jobType: string;
    target?: unknown;
    editionId?: string;
  },
): ProcessingJob {
  return {
    id: overrides.id ?? randomUUID(),
    job_type: overrides.jobType,
    edition_id: overrides.editionId ?? null,
    target: overrides.target ?? null,
    status: overrides.status ?? "running",
    retry_count: 0,
    last_error: null,
    last_attempt_at: null,
    next_eligible_at: new Date(),
    locked_by: "test-worker",
    locked_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    depends_on: [],
  };
}

interface PipelineState {
  editionId: string;
  discoveryEvents: Array<{ id: string; url: string; minifluxEntryId: number }>;
  documentIds: string[];
  sectionIds: string[];
  chunkIds: string[];
  storyIds: string[];
  notebookId: string | null;
  podcastId: string | null;
}

function emptyState(): PipelineState {
  return {
    editionId: "",
    discoveryEvents: [],
    documentIds: [],
    sectionIds: [],
    chunkIds: [],
    storyIds: [],
    notebookId: null,
    podcastId: null,
  };
}

async function runDiscoveryStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const entries: MinifluxEntry[] = [
    {
      id: 100,
      feedId: 1,
      title: "Article about AI",
      url: "https://example.com/articles/1",
      hash: "h1",
    },
    {
      id: 200,
      feedId: 2,
      title: "YouTube deep dive",
      url: "https://www.youtube.com/watch?v=abc",
      hash: "h2",
    },
  ];
  const { client, calls } = makeFakeMiniflux({ pages: [entries, []] });
  const service = createDiscoveryService({
    db: env.db,
    editionRepo: env.editionRepo,
    discoveryRepo: env.discoveryRepo,
    queue: env.jobQueue,
    logger: silentLogger(),
  });
  const result = await service.discover({
    editionDate: "2026-07-07",
    miniflux: client,
  });
  expect(result.total).toBe(2);
  expect(result.created).toBe(2);
  expect(calls.markEntryRead).toEqual([100, 200]);
  state.editionId = result.editionId;
  for (const id of [100, 200]) {
    const ev = await env.discoveryRepo.getByMinifluxEntryId(id);
    expect(ev).toBeDefined();
    state.discoveryEvents.push({
      id: ev!.id,
      url: ev!.url,
      minifluxEntryId: id,
    });
  }
}

async function runExpansionStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  env.pluginRegistry.register(
    createArticlePlugin({
      fetchContent: async (_url: string) => makeArticleContent(1),
    }),
  );
  env.pluginRegistry.register(
    createYouTubePlugin({
      transcriptFetcher: async (_url: string) => makeYouTubeContent(2).raw,
      metadataFetcher: async (_url: string) => makeYouTubeContent(2).meta,
    }),
  );

  for (const ev of state.discoveryEvents) {
    const job = await env.jobQueue.enqueue({
      jobType: "expand_document",
      editionId: state.editionId,
      target: { discoveryEventId: ev.id, url: ev.url },
    });
    const worker = createExpandDocumentWorker({
      docRepo: env.docRepo,
      sectionRepo: env.sectionRepo,
      pluginRegistry: env.pluginRegistry,
      provenanceRepo: env.provenanceRepo,
      queue: env.jobQueue,
    });
    const outcome = await worker.execute(
      job,
      { db: env.db, logger: silentLogger() },
    );
    if (outcome.childJobs) {
      for (const cj of outcome.childJobs) {
        await env.jobQueue.enqueue({
          jobType: cj.jobType,
          editionId: cj.editionId,
          target: cj.target,
          dependsOn: cj.dependsOn,
        });
      }
    }
    await env.jobQueue.complete(job.id);
  }
}

async function runChunkStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const chunkWorker = createChunkDocumentWorker({
    docRepo: env.docRepo,
    sectionRepo: env.sectionRepo,
    chunkRepo: env.chunkRepo,
    provenanceRepo: env.provenanceRepo,
    enrichmentTracker: env.enrichmentTracker,
    editionRepo: env.editionRepo,
  });
  const docs = await env.docRepo.getByEdition(state.editionId);
  for (const doc of docs) {
    const sections = await env.sectionRepo.getByDocumentId(doc.id);
    for (const s of sections) state.sectionIds.push(s.id);
    state.documentIds.push(doc.id);
    const job = await env.jobQueue.enqueue({
      jobType: "chunk_document",
      editionId: state.editionId,
      target: { documentId: doc.id },
    });
    const outcome = await chunkWorker.execute(
      job,
      { db: env.db, logger: silentLogger() },
    );
    if (outcome.childJobs) {
      for (const cj of outcome.childJobs) {
        await env.jobQueue.enqueue({
          jobType: cj.jobType,
          editionId: cj.editionId,
          target: cj.target,
          dependsOn: cj.dependsOn,
        });
      }
    }
    await env.jobQueue.complete(job.id);
    const chunks = await env.chunkRepo.getByDocumentId(doc.id);
    for (const c of chunks) state.chunkIds.push(c.id);
  }
}

async function runEnrichmentStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  await seedDefaultPrompts(env.promptRepo, silentLogger());
  const summarizeWorker = createSummarizeChunkWorker({
    chunkRepo: env.chunkRepo,
    summaryRepo: env.summaryRepo,
    promptRepo: env.promptRepo,
    promptExecutor: env.promptExecutor,
    provider: env.provider,
    provenanceRepo: env.provenanceRepo,
    gate: env.enrichmentGate,
    editionRepo: env.editionRepo,
  });
  const entitiesWorker = createExtractEntitiesWorker({
    chunkRepo: env.chunkRepo,
    entityRepo: env.entityRepo,
    promptRepo: env.promptRepo,
    promptExecutor: env.promptExecutor,
    provider: env.provider,
    provenanceRepo: env.provenanceRepo,
    gate: env.enrichmentGate,
    editionRepo: env.editionRepo,
  });
  const topicsWorker = createAssignTopicsWorker({
    chunkRepo: env.chunkRepo,
    topicRepo: env.topicRepo,
    promptRepo: env.promptRepo,
    promptExecutor: env.promptExecutor,
    provider: env.provider,
    provenanceRepo: env.provenanceRepo,
    gate: env.enrichmentGate,
    editionRepo: env.editionRepo,
  });
  const qualityWorker = createClassifyQualityWorker({
    chunkRepo: env.chunkRepo,
    qualityRepo: env.qualityRepo,
    promptRepo: env.promptRepo,
    promptExecutor: env.promptExecutor,
    provider: env.provider,
    provenanceRepo: env.provenanceRepo,
    gate: env.enrichmentGate,
    editionRepo: env.editionRepo,
  });
  const embedWorker = createEmbedChunkWorker({
    chunkRepo: env.chunkRepo,
    embeddingRepo: env.embeddingRepo,
    embeddingProvider: env.embeddingProvider,
    provenanceRepo: env.provenanceRepo,
    gate: env.enrichmentGate,
    editionRepo: env.editionRepo,
  });

  const workerByType: Record<string, Worker> = {
    summarize_chunk: summarizeWorker,
    extract_entities: entitiesWorker,
    assign_topics: topicsWorker,
    classify_quality: qualityWorker,
    embed_chunk: embedWorker,
  };

  for (const chunkId of state.chunkIds) {
    const docId = (await env.db
      .selectFrom("document_chunks")
      .select("document_id")
      .where("id", "=", chunkId)
      .executeTakeFirstOrThrow()).document_id;
    for (const jobType of REQUIRED_ENRICHMENT_TYPES) {
      const job = await env.jobQueue.enqueue({
        jobType,
        editionId: state.editionId,
        target: { chunkId, documentId: docId },
      });
      const outcome = await workerByType[jobType]!.execute(
        job,
        { db: env.db, logger: silentLogger() },
      );
      if (outcome.childJobs) {
        for (const cj of outcome.childJobs) {
          await env.jobQueue.enqueue({
            jobType: cj.jobType,
            editionId: cj.editionId,
            target: cj.target,
            dependsOn: cj.dependsOn,
          });
        }
      }
      await env.jobQueue.complete(job.id);
    }
  }
}

async function runClusterStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const worker = createClusterStoriesWorker({
    docRepo: env.docRepo,
    summaryRepo: env.summaryRepo,
    topicRepo: env.topicRepo,
    embeddingRepo: env.embeddingRepo,
    storyRepo: env.storyRepo,
    provenanceRepo: env.provenanceRepo,
    signalRepo: env.signalRepo,
    sourceTrustRepo: env.sourceTrustRepo,
    enrichmentTracker: env.enrichmentTracker,
  });
  const job = await env.jobQueue.enqueue({
    jobType: "cluster_stories",
    editionId: state.editionId,
    target: { editionId: state.editionId },
  });
  const outcome = await worker.execute(
    job,
    { db: env.db, logger: silentLogger() },
  );
  if (outcome.childJobs) {
    for (const cj of outcome.childJobs) {
      await env.jobQueue.enqueue({
        jobType: cj.jobType,
        editionId: cj.editionId,
        target: cj.target,
        dependsOn: cj.dependsOn,
      });
    }
  }
  await env.jobQueue.complete(job.id);
}

async function runSummarizeStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const worker = createSummarizeStoryWorker({
    storyRepo: env.storyRepo,
    storySummaryRepo: env.storySummaryRepo,
    docRepo: env.docRepo,
    chunkRepo: env.chunkRepo,
    summaryRepo: env.summaryRepo,
    promptRepo: env.promptRepo,
    promptExecutor: env.promptExecutor,
    provider: env.provider,
    provenanceRepo: env.provenanceRepo,
    signalRepo: env.signalRepo,
  });
  const stories = await env.storyRepo.getByEdition(state.editionId);
  for (const s of stories) {
    state.storyIds.push(s.story.id);
    const job = await env.jobQueue.enqueue({
      jobType: "summarize_story",
      editionId: state.editionId,
      target: { storyId: s.story.id },
    });
    const outcome = await worker.execute(
      job,
      { db: env.db, logger: silentLogger() },
    );
    if (outcome.childJobs) {
      for (const cj of outcome.childJobs) {
        await env.jobQueue.enqueue({
          jobType: cj.jobType,
          editionId: cj.editionId,
          target: cj.target,
          dependsOn: cj.dependsOn,
        });
      }
    }
    await env.jobQueue.complete(job.id);
  }
}

async function runDigestStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  await env.markdownService.generate({ editionId: state.editionId });
}

async function runEmailStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  env.captured.length = 0;
  const resend = makeFakeResend({
    outcome: {
      ok: true,
      status: 200,
      messageId: "msg-m13",
      raw: { id: "msg-m13" },
    },
    captured: env.captured,
  });
  const service = createEmailDigestService({
    db: env.db,
    editionRepo: env.editionRepo,
    markdownDigestRepo: env.markdownDigestRepo,
    emailDigestRepo: env.emailDigestRepo,
    resend,
    config: {
      fromAddress: "Digest <digest@example.com>",
      toAddresses: ["reader@example.com"],
    },
    logger: silentLogger(),
  });
  const result = await service.send({ editionId: state.editionId });
  expect(result.deliveryStatus).toBe("sent");
}

async function runNotebookStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const notebookLm = makeFakeNotebookLm();
  const service = createNotebookService({
    db: env.db,
    editionRepo: env.editionRepo,
    docRepo: env.docRepo,
    notebookRepo: env.notebookRepo,
    notebookLm,
    config: { partitionMinArticles: 0 },
    logger: silentLogger(),
  });
  const result = await service.generate({
    editionId: state.editionId,
    wait: true,
  });
  expect(result.status).toBe("ready");
  state.notebookId = result.notebookId;
}

async function runPodcastStep(
  env: TestEnv,
  state: PipelineState,
): Promise<void> {
  const notebookLm = makeFakeNotebookLm();
  const service = createPodcastService({
    db: env.db,
    editionRepo: env.editionRepo,
    markdownDigestRepo: env.markdownDigestRepo,
    notebookRepo: env.notebookRepo,
    podcastRepo: env.podcastRepo,
    notebookLm,
    logger: silentLogger(),
  });
  const result = await service.generate({
    editionId: state.editionId,
    wait: true,
  });
  expect(result.status).toBe("ready");
  state.podcastId = result.podcastId;
}

async function buildFullPipeline(env: TestEnv): Promise<PipelineState> {
  const state = emptyState();
  await runDiscoveryStep(env, state);
  await runExpansionStep(env, state);
  await runChunkStep(env, state);
  await runEnrichmentStep(env, state);
  await runClusterStep(env, state);
  await runSummarizeStep(env, state);
  const ready = await env.readinessGate.transitionToReadyIfReady(state.editionId);
  expect(ready.transitioned).toBe(true);
  await runDigestStep(env, state);
  await runEmailStep(env, state);
  await runNotebookStep(env, state);
  await runPodcastStep(env, state);
  return state;
}

const itWithDb = process.env.TEST_DATABASE_URL ? it : it.skip;

describe("M13 §61 acceptance criteria — full pipeline", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let env: TestEnv;
  const schema = schemaName("m13_acc_");

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
    await pool.query(`TRUNCATE TABLE ${schema}.entity_mentions CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.topic_assignments CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.topics CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.summary_citations CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.summaries CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_chunks CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.document_sections CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.discovery_events CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.signals CASCADE`);
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

  async function insertJob(
    editionId: string,
    status: "pending" | "running" | "completed" | "failed",
    jobType: string,
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

  itWithDb("§61.1–3 discovery persists events and only acks Miniflux after persistence", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);

    const eventRows = await pool.query(
      `SELECT miniflux_entry_id::text AS miniflux_entry_id, url FROM ${schema}.discovery_events
       WHERE edition_id = $1 ORDER BY miniflux_entry_id::text ASC`,
      [state.editionId],
    );
    expect(eventRows.rows.length).toBe(2);
    const urls = eventRows.rows.map((r) => r.url);
    expect(urls).toContain("https://example.com/articles/1");
    expect(urls).toContain("https://www.youtube.com/watch?v=abc");

    const jobRows = await pool.query(
      `SELECT job_type, status FROM ${schema}.processing_jobs WHERE edition_id = $1`,
      [state.editionId],
    );
    expect(jobRows.rows.length).toBe(2);
    for (const r of jobRows.rows) {
      expect(r.job_type).toBe("expand_document");
      expect(r.status).toBe("pending");
    }
  });

  itWithDb("§61.4 supported sources expand into canonical documents via Fabric-shaped plugin", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);

    const docRows = await pool.query(
      `SELECT source_type, source_url, content_markdown FROM ${schema}.documents
       WHERE edition_id = $1 ORDER BY source_url ASC`,
      [state.editionId],
    );
    expect(docRows.rows.length).toBe(2);
    const types = docRows.rows.map((r) => r.source_type);
    expect(types).toContain("article");
    expect(types).toContain("youtube");
    for (const row of docRows.rows) {
      expect(typeof row.content_markdown).toBe("string");
      expect(row.content_markdown.length).toBeGreaterThan(0);
    }
  });

  itWithDb("§61.5 canonical documents are sectioned and chunked", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);

    const sectionRows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.document_sections ds
       JOIN ${schema}.documents d ON d.id = ds.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(sectionRows.rows[0].n).toBeGreaterThan(0);

    const chunkRows = await pool.query(
      `SELECT dc.content_text, dc.start_offset, dc.end_offset FROM ${schema}.document_chunks dc
       JOIN ${schema}.documents d ON d.id = dc.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(chunkRows.rows.length).toBeGreaterThan(0);
    for (const r of chunkRows.rows) {
      expect(typeof r.content_text).toBe("string");
      expect(r.content_text.length).toBeGreaterThan(0);
      expect(r.end_offset).toBeGreaterThanOrEqual(r.start_offset);
    }
  });

  itWithDb("§61.6 every chunk carries provenance metadata linking chunk → section → document", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);

    const rows = await pool.query(
      `SELECT dc.id AS chunk_id, dc.section_id, dl.source_type, dl.target_type, dl.relation
       FROM ${schema}.document_chunks dc
       JOIN ${schema}.document_lineage dl
         ON dl.target_type = 'chunk' AND dl.target_id = dc.id::uuid
       JOIN ${schema}.documents d ON d.id = dc.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(rows.rows.length).toBe(state.chunkIds.length);
    for (const r of rows.rows) {
      expect(r.source_type).toBe("section");
      expect(r.target_type).toBe("chunk");
      expect(r.relation).toBe("chunked_from");
      expect(typeof r.section_id).toBe("string");
    }
  });

  itWithDb("§61.7–8 AI artifacts generated with prompt and model metadata", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);

    const summaryRows = await pool.query(
      `SELECT prompt_id, prompt_version, model, provider, input_hash FROM ${schema}.summaries
       WHERE document_id IN (SELECT id FROM ${schema}.documents WHERE edition_id = $1)
       LIMIT 1`,
      [state.editionId],
    );
    expect(summaryRows.rows.length).toBeGreaterThan(0);
    const s = summaryRows.rows[0];
    expect(typeof s.prompt_id).toBe("string");
    expect(s.prompt_version).toBeGreaterThan(0);
    expect(s.model).toBe("fake-text");
    expect(s.provider).toBe("fake");
    expect(typeof s.input_hash).toBe("string");
    expect(s.input_hash.length).toBeGreaterThan(0);

    const entityCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.entities e
       JOIN ${schema}.documents d ON d.id = e.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(entityCount.rows[0].n).toBeGreaterThan(0);

    const topicCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.topics t
       JOIN ${schema}.documents d ON d.id = t.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(topicCount.rows[0].n).toBeGreaterThan(0);

    const embeddingCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.embeddings e
       JOIN ${schema}.document_chunks dc ON dc.id = e.chunk_id
       JOIN ${schema}.documents d ON d.id = dc.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(embeddingCount.rows[0].n).toBeGreaterThan(0);

    const qualityCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.quality_classifications q
       JOIN ${schema}.documents d ON d.id = q.document_id
       WHERE d.edition_id = $1`,
      [state.editionId],
    );
    expect(qualityCount.rows[0].n).toBeGreaterThan(0);
  });

  itWithDb("§61.9 story clusters preserve provenance to source chunks", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);
    await runClusterStep(env, state);
    await runSummarizeStep(env, state);

    const clusterCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.story_clusters WHERE edition_id = $1`,
      [state.editionId],
    );
    expect(clusterCount.rows[0].n).toBeGreaterThan(0);

    const memberCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.cluster_members cm
       JOIN ${schema}.story_clusters sc ON sc.id = cm.story_id
       WHERE sc.edition_id = $1`,
      [state.editionId],
    );
    expect(memberCount.rows[0].n).toBe(state.documentIds.length);

    const citationRows = await pool.query(
      `SELECT ssc.chunk_id FROM ${schema}.story_summary_citations ssc
       JOIN ${schema}.story_summaries ss ON ss.id = ssc.story_summary_id
       JOIN ${schema}.story_clusters sc ON sc.id = ss.story_id
       WHERE sc.edition_id = $1`,
      [state.editionId],
    );
    expect(citationRows.rows.length).toBeGreaterThan(0);
    const knownChunkIds = new Set(state.chunkIds);
    for (const r of citationRows.rows) {
      expect(knownChunkIds.has(r.chunk_id)).toBe(true);
    }
  });

  itWithDb("§61.10 markdown digest generated with citations and story labels", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);
    await runClusterStep(env, state);
    await runSummarizeStep(env, state);
    await runDigestStep(env, state);

    const row = (
      await pool.query(
        `SELECT content, story_count, citation_count FROM ${schema}.markdown_digests
         WHERE edition_id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.content).toMatch(/\[1\]/);
    expect(row.content).toContain("Story summary text combining source documents.");
    expect(row.story_count).toBeGreaterThan(0);
    expect(row.citation_count).toBeGreaterThan(0);
  });

  itWithDb("§61.11 HTML email is rendered exclusively from Markdown", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);
    await runClusterStep(env, state);
    await runSummarizeStep(env, state);
    await runDigestStep(env, state);
    await runEmailStep(env, state);

    const row = (
      await pool.query(
        `SELECT html_content, text_content FROM ${schema}.email_digests
         WHERE edition_id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.html_content).toContain("<!doctype html>");
    expect(row.html_content).toContain("Daily Digest");
    expect(row.html_content).toContain("AI Article");
    expect(row.html_content).toMatch(/\[1\]/);
    expect(row.text_content).toContain("Daily Digest");
  });

  itWithDb("§61.12 email delivered through Resend with idempotency key", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);
    await runClusterStep(env, state);
    await runSummarizeStep(env, state);
    await runDigestStep(env, state);
    await runEmailStep(env, state);

    expect(env.captured.length).toBe(1);
    const call = env.captured[0]!;
    expect(call.url).toBe("https://api.resend.local/emails");
    expect(call.init.headers?.["Authorization"]).toBe("Bearer re_test");
    expect(call.init.headers?.["Idempotency-Key"]).toMatch(new RegExp(`^pnip:${state.editionId}:`));
    const body = JSON.parse(call.init.body!);
    expect(body.from).toBe("Digest <digest@example.com>");
    expect(body.to).toEqual(["reader@example.com"]);
    expect(body.subject).toBe("Daily Digest — 2026-07-07");

    const row = (
      await pool.query(
        `SELECT delivery_status, provider_message_id FROM ${schema}.email_digests
         WHERE edition_id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(row.delivery_status).toBe("sent");
    expect(row.provider_message_id).toBe("msg-m13");
  });

  itWithDb("§61.13–15 NotebookLM notebook + podcast generated and metadata persisted", async () => {
    const state = emptyState();
    await runDiscoveryStep(env, state);
    await runExpansionStep(env, state);
    await runChunkStep(env, state);
    await runEnrichmentStep(env, state);
    await runClusterStep(env, state);
    await runSummarizeStep(env, state);
    await runDigestStep(env, state);
    await runEmailStep(env, state);
    await runNotebookStep(env, state);
    await runPodcastStep(env, state);

    const notebook = (
      await pool.query(
        `SELECT status, url, source_count FROM ${schema}.notebooks WHERE edition_id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(notebook).toBeDefined();
    expect(notebook.status).toBe("ready");
    expect(typeof notebook.url).toBe("string");
    expect(notebook.url.length).toBeGreaterThan(0);
    expect(notebook.source_count).toBeGreaterThan(0);

    const podcast = (
      await pool.query(
        `SELECT status, url, artifact_external_id FROM ${schema}.podcasts WHERE edition_id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(podcast).toBeDefined();
    expect(podcast.status).toBe("ready");
    expect(typeof podcast.url).toBe("string");
    expect(podcast.url.length).toBeGreaterThan(0);
    expect(podcast.artifact_external_id.length).toBeGreaterThan(0);
  });

  itWithDb("§61.16–17 publication transitions edition to Published and freezes it", async () => {
    const state = await buildFullPipeline(env);

    const published = await env.publishService.publish({ editionId: state.editionId });
    expect(published.status).toBe("published");
    expect(published.edition.status).toBe("published");

    const row = (
      await pool.query(
        `SELECT status, published_at FROM ${schema}.editions WHERE id = $1`,
        [state.editionId],
      )
    ).rows[0];
    expect(row.status).toBe("published");
    expect(row.published_at).not.toBeNull();

    await expect(
      env.editionRepo.transition(state.editionId, "ready"),
    ).rejects.toBeInstanceOf(InvalidEditionTransitionError);

    const second = await env.publishService.publish({ editionId: state.editionId });
    expect(second.status).toBe("already_published");
    expect(second.alreadyExisted).toBe(true);
  });

  itWithDb("§61.18–20 reddit refresh termination, no duplicates after restart, resumable from any stage", async () => {
    const state = await buildFullPipeline(env);

    await insertJob(state.editionId, "pending", "reddit_refresh");
    await insertJob(state.editionId, "running", "reddit_refresh");

    const pub = await env.publishService.publish({ editionId: state.editionId });
    expect(pub.status).toBe("published");

    const redditRows = await pool.query(
      `SELECT status, last_error FROM ${schema}.processing_jobs
       WHERE edition_id = $1 AND job_type = 'reddit_refresh'`,
      [state.editionId],
    );
    expect(redditRows.rows.length).toBe(2);
    for (const r of redditRows.rows) {
      expect(r.status).toBe("failed");
      expect(r.last_error.type).toBe("JobCancelledError");
    }

    const selfTerminatingWorker = createChunkDocumentWorker({
      docRepo: env.docRepo,
      sectionRepo: env.sectionRepo,
      chunkRepo: env.chunkRepo,
      provenanceRepo: env.provenanceRepo,
      enrichmentTracker: env.enrichmentTracker,
      editionRepo: env.editionRepo,
    });
    const fabricatedJob: ProcessingJob = makeProcessingJob({
      jobType: "chunk_document",
      editionId: state.editionId,
      target: { documentId: state.documentIds[0] },
    });
    const afterPublish = await selfTerminatingWorker.execute(
      fabricatedJob,
      { db: env.db, logger: silentLogger() },
    );
    expect(afterPublish).toEqual({});

    const restartEdition = await env.editionRepo.create("2026-07-08");
    await env.docRepo.create({
      editionId: restartEdition.id,
      sourceType: "article",
      sourceUrl: "https://example.com/restart/1",
    });
    const resumeJob = await env.jobQueue.enqueue({
      jobType: "expand_document",
      editionId: restartEdition.id,
      target: {
        discoveryEventId: randomUUID(),
        url: "https://example.com/restart/1",
      },
    });
    env.pluginRegistry.register(
      createArticlePlugin({
        fetchContent: async (_url: string) => makeArticleContent(99),
      }),
    );
    const expandWorker = createExpandDocumentWorker({
      docRepo: env.docRepo,
      sectionRepo: env.sectionRepo,
      pluginRegistry: env.pluginRegistry,
      provenanceRepo: env.provenanceRepo,
      queue: env.jobQueue,
    });
    const runtime: WorkerRuntime = createWorkerRuntime({
      db: env.db,
      queue: env.jobQueue,
      workers: [expandWorker],
      logger: silentLogger(),
    });
    const didRun = await runtime.runOne("restart-worker");
    expect(didRun).toBe(true);
    const afterTick = (
      await pool.query(
        `SELECT status FROM ${schema}.processing_jobs WHERE id = $1`,
        [resumeJob.id],
      )
    ).rows[0];
    expect(afterTick.status).toBe("completed");

    const docCountAfter = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${schema}.documents
         WHERE edition_id = $1 AND source_url = $2`,
        [restartEdition.id, "https://example.com/restart/1"],
      )
    ).rows[0].n;
    expect(docCountAfter).toBe(1);
  });

  itWithDb("§65.4 every published edition writes claimed_in_top, clustered_into_story, and chunk_in_story signals", async () => {
    const state = await buildFullPipeline(env);

    const published = await env.publishService.publish({ editionId: state.editionId });
    expect(published.status).toBe("published");

    const claimedInTop = await env.signalRepo.countByEditionAndKind(
      state.editionId,
      "claimed_in_top",
    );
    expect(claimedInTop).toBeGreaterThanOrEqual(1);

    const clusteredIntoStory = await env.signalRepo.countByEditionAndKind(
      state.editionId,
      "clustered_into_story",
    );
    expect(clusteredIntoStory).toBeGreaterThanOrEqual(1);

    const chunkInStory = await env.signalRepo.countByEditionAndKind(
      state.editionId,
      "chunk_in_story",
    );
    expect(chunkInStory).toBeGreaterThanOrEqual(1);
  });

  itWithDb("§65 feedback loop end-to-end: signals → bias view", async () => {
    const state = await buildFullPipeline(env);
    const storyId1 = state.storyIds[0]!;
    const storyId2 = state.storyIds[1] ?? state.storyIds[0]!;
    const sourceUrl = (await env.docRepo.getById(state.documentIds[0]!))!.source_url;

    const deps = {
      signalRepo: env.signalRepo,
      editionRepo: env.editionRepo,
      storyRepo: env.storyRepo,
      docRepo: env.docRepo,
      chunkRepo: env.chunkRepo,
      log: () => {},
    };

    const r1 = await runFeedbackRate(deps, state.editionId, storyId1, "up");
    expect(r1.exitCode).toBe(0);
    const r2 = await runFeedbackRate(deps, state.editionId, storyId2, "down");
    expect(r2.exitCode).toBe(0);
    const r3 = await runFeedbackHide(deps, sourceUrl, state.editionId);
    expect(r3.exitCode).toBe(0);

    expect(
      await env.signalRepo.countByEditionAndKind(state.editionId, "story_up"),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await env.signalRepo.countByEditionAndKind(state.editionId, "story_down"),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await env.signalRepo.countByEditionAndKind(state.editionId, "source_muted"),
    ).toBeGreaterThanOrEqual(1);

    const biasView = await getBiasView(env.db, state.editionId);
    expect(biasView.storyBias.get(storyId1)?.up_votes).toBeGreaterThanOrEqual(1);
    expect(biasView.storyBias.get(storyId2)?.down_votes).toBeGreaterThanOrEqual(1);
    expect(biasView.mutedSourceIdentities.size).toBeGreaterThanOrEqual(1);
  });
});