import {
  loadConfig,
  parsePartitionConfig,
  parseYoutubeFocusChannels,
} from "../config/index.js";
import { createPool } from "../database/pool.js";
import { runMigrations } from "../database/migrations.js";
import { createKysely, closeKysely } from "../database/kysely.js";
import type { Database } from "../database/kysely.js";
import type { Kysely } from "kysely";
import { createMinifluxClient } from "../discovery/miniflux-client.js";
import { createEditionRepository } from "../editions/edition-repository.js";
import { createEnrichmentTrackerRepository } from "../editions/enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "../editions/enrichment-gate-service.js";
import { reconcileMissingClusterJobs } from "../editions/cluster-reconciliation.js";
import { createDiscoveryRepository } from "../discovery/discovery-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import { createDiscoveryService } from "../discovery/discovery-service.js";
import { createLogger } from "../logging/logger.js";
import { createWorkerRuntime } from "../jobs/workers/worker-runtime.js";
import { createExpandDocumentWorker } from "../expansion/expand-document-worker.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import { createChunkDocumentWorker } from "../chunking/chunk-document-worker.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createProvenanceRepository } from "../provenance/provenance-repository.js";
import { createPromptRepository } from "../prompts/prompt-repository.js";
import { createPromptExecutionService } from "../ai/prompt-execution.js";
import { createVercelAiProvider } from "../ai/vercel-provider.js";
import { createOpenAICompatibleProvider } from "../ai/openai-compatible-provider.js";
import { createFakeProvider } from "../ai/fake-provider.js";
import { createTransformersJsEmbeddingProvider } from "../ai/transformersjs-embedding-provider.js";
import { createFakeEmbeddingProvider } from "../ai/fake-embedding-provider.js";
import { seedDefaultPrompts } from "../prompts/seed-default-prompts.js";
import { createSummaryRepository } from "../enrichment/summary/summary-repository.js";
import { createSummarizeChunkWorker } from "../enrichment/summary/summarize-chunk-worker.js";
import { createEntityRepository } from "../enrichment/entities/entity-repository.js";
import { createExtractEntitiesWorker } from "../enrichment/entities/extract-entities-worker.js";
import { createTopicRepository } from "../enrichment/topics/topic-repository.js";
import { createAssignTopicsWorker } from "../enrichment/topics/assign-topics-worker.js";
import { createQualityRepository } from "../enrichment/quality/quality-repository.js";
import { createClassifyQualityWorker } from "../enrichment/quality/classify-quality-worker.js";
import { createEmbeddingRepository } from "../enrichment/embeddings/embedding-repository.js";
import { createEmbedChunkWorker } from "../enrichment/embeddings/embed-chunk-worker.js";
import { createClusterStoriesWorker } from "../clustering/cluster-stories-worker.js";
import { createSummarizeStoryWorker } from "../clustering/summarize-story-worker.js";
import { buildPluginRegistry } from "./process-registry.js";
import { parseCommand } from "./args.js";
import { runDiscoverCommand } from "./discover.js";
import { parseMaintenanceFlags, runMaintenance, MAINTENANCE_HELP } from "./maintenance.js";
import {
  GENERATE_DIGEST_HELP,
  parseGenerateDigestFlags,
  runGenerateDigestCommand,
} from "./generate-digest.js";
import {
  GENERATE_EMAIL_HELP,
  parseGenerateEmailFlags,
  runGenerateEmailCommand,
} from "./generate-email.js";
import {
  GENERATE_NOTEBOOK_HELP,
  parseGenerateNotebookFlags,
  runGenerateNotebookCommand,
} from "./generate-notebook.js";
import {
  GENERATE_PODCAST_HELP,
  parseGeneratePodcastFlags,
  runGeneratePodcastCommand,
} from "./generate-podcast.js";
import {
  PUBLISH_EDITION_HELP,
  parsePublishEditionFlags,
  runPublishEditionCommand,
} from "./publish-edition.js";
import {
  DOCTOR_HELP,
  runDoctorCommand,
} from "./doctor.js";
import {
  METRICS_HELP,
  parseMetricsFlags,
  runMetricsCommand,
} from "./metrics.js";
import {
  PARTITIONS_HELP,
  parsePartitionsFlags,
  runPartitionsCommand,
} from "./partitions.js";
import { parseActivePartitionsDate, runActivePartitionsCommand } from "./active-partitions.js";
import { getActivePartitions } from "../publication/active-partitions.js";
import {
  GENERATE_EDITION_HELP,
  parseGenerateEditionFlags,
  runGenerateEditionCommand,
} from "./generate-edition.js";
import {
  RETRY_HELP,
  parseRetryFlags,
  runRetryCommand,
} from "./retry.js";
import { createMarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import { createMarkdownDigestService } from "../digest/markdown/markdown-digest-service.js";
import { createEditionAssemblyService } from "../editions/edition-assembly-service.js";
import { createEditionReadinessGate } from "../editions/edition-readiness-gate.js";
import { createStorySummaryRepository } from "../clustering/story-summary-repository.js";
import { createStoryRepository } from "../clustering/story-repository.js";
import { createEmailDigestRepository } from "../digest/html/email-digest-repository.js";
import { createEmailDigestService } from "../digest/html/email-digest-service.js";
import { createResendClient } from "../digest/html/resend-client.js";
import { createNotebookRepository } from "../digest/notebooklm/notebook-repository.js";
import { createPodcastRepository } from "../digest/notebooklm/podcast-repository.js";
import { createNotebookLmClient } from "../digest/notebooklm/notebooklm-client.js";
import { createNotebookService } from "../digest/notebooklm/notebook-service.js";
import { createPodcastService } from "../digest/notebooklm/podcast-service.js";
import { createPublicationService } from "../publication/publication-service.js";
import { createSignalRepository } from "../signals/signal-repository.js";
import { createSourceTrustRepository } from "../signals/source-trust-repository.js";
import {
  FEEDBACK_HELP,
  runFeedbackCommand,
} from "./feedback.js";
import {
  SOURCE_TRUST_HELP,
  runSourceTrustCommand,
} from "./source-trust.js";
import {
  FEEDBACK_SUMMARY_HELP,
  runFeedbackSummaryCommand,
} from "./feedback-summary.js";

const DEFAULT_WORKER_CONCURRENCY = 4;
const MAX_WORKER_CONCURRENCY = 16;

function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
  maximum?: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

export function resolveWorkerConcurrency(raw?: string): number {
  return resolvePositiveInt(raw, DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY);
}

async function main(): Promise<number> {
  const cfg = loadConfig();

  const pool = createPool(cfg.DATABASE_URL);
  let db: Kysely<Database> | undefined;
  try {
    await runMigrations(pool);
    db = createKysely(pool);

    const { command, rest } = parseCommand(process.argv);

    if (command === "discover") {
      if (!cfg.MINIFLUX_URL || !cfg.MINIFLUX_API_TOKEN) {
        console.log("MINIFLUX_URL and MINIFLUX_API_TOKEN are required for discover");
        return 1;
      }

      const miniflux = createMinifluxClient({
        baseUrl: cfg.MINIFLUX_URL,
        token: cfg.MINIFLUX_API_TOKEN,
      });

      const editionRepo = createEditionRepository(db);
      const discoveryRepo = createDiscoveryRepository(db);
      const queue = createProcessingJobQueue(db);
      const partitionConfig = parsePartitionConfig(cfg.PARTITION_CONFIG);
      const service = createDiscoveryService({
        db,
        editionRepo,
        discoveryRepo,
        queue,
        partitionConfig,
        logger: createLogger({ baseFields: { worker: "discovery" } }),
      });

      const dateFlag = rest.length >= 2 && rest[0] === "--date" ? rest[1] : undefined;
      const { exitCode } = await runDiscoverCommand({
        service,
        miniflux,
        editionDate: dateFlag,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "process") {
      const logger = createLogger({ baseFields: { worker: "cli" } });
      const youtubeFocusChannels = parseYoutubeFocusChannels(
        cfg.YOUTUBE_FOCUS_CHANNELS,
      );

      const docRepo = createDocumentRepository(db);
      const sectionRepo = createSectionRepository(db);
      const provenanceRepo = createProvenanceRepository(db);
      const promptRepo = createPromptRepository(db);
      const editionRepo = createEditionRepository(db);

      const seedSummary = await seedDefaultPrompts(promptRepo, logger);
      logger.info("prompt seeding complete", {
        created: seedSummary.created,
        skipped: seedSummary.skipped,
      });

      const aiProvider =
        cfg.AI_PROVIDER === "fake"
          ? createFakeProvider()
          : cfg.AI_PROVIDER === "openai-compatible"
            ? createOpenAICompatibleProvider({
                baseURL: cfg.OPENAI_BASE_URL ?? "http://localhost:20128/v1",
                apiKey: cfg.OPENAI_API_KEY ?? "",
                textModel: cfg.AI_TEXT_MODEL,
              })
            : createVercelAiProvider({ textModel: cfg.AI_TEXT_MODEL });

      const embeddingProvider = cfg.AI_PROVIDER === "fake"
        ? createFakeEmbeddingProvider({ dimension: 8 })
        : createTransformersJsEmbeddingProvider({
            model: cfg.EMBEDDING_MODEL,
            cacheDir: cfg.EMBEDDING_CACHE_DIR,
          });

      const promptExecutor = createPromptExecutionService();

      const registry = buildPluginRegistry();
      const queue = createProcessingJobQueue(db);
      const expandWorker = createExpandDocumentWorker({
        docRepo,
        sectionRepo,
        pluginRegistry: registry,
        provenanceRepo,
        queue,
      });

      const chunkRepo = createChunkRepository(db);
      const enrichmentTracker = createEnrichmentTrackerRepository(db);
      const enrichmentGate = createEnrichmentGateService({ db, tracker: enrichmentTracker });

      const chunkWorker = createChunkDocumentWorker({
        docRepo,
        sectionRepo,
        chunkRepo,
        provenanceRepo,
        enrichmentTracker,
        editionRepo,
      });

      const summaryRepo = createSummaryRepository(db);
      const summaryWorker = createSummarizeChunkWorker({
        chunkRepo,
        summaryRepo,
        promptRepo,
        promptExecutor,
        provider: aiProvider,
        provenanceRepo,
        gate: enrichmentGate,
        editionRepo,
        model: cfg.AI_TEXT_MODEL,
      });

      const entityRepo = createEntityRepository(db);
      const entitiesWorker = createExtractEntitiesWorker({
        chunkRepo,
        entityRepo,
        promptRepo,
        promptExecutor,
        provider: aiProvider,
        provenanceRepo,
        gate: enrichmentGate,
        editionRepo,
        model: cfg.AI_TEXT_MODEL,
      });

      const topicRepo = createTopicRepository(db);
      const topicsWorker = createAssignTopicsWorker({
        chunkRepo,
        topicRepo,
        promptRepo,
        promptExecutor,
        provider: aiProvider,
        provenanceRepo,
        gate: enrichmentGate,
        editionRepo,
        model: cfg.AI_TEXT_MODEL,
      });

      const qualityRepo = createQualityRepository(db);
      const qualityWorker = createClassifyQualityWorker({
        chunkRepo,
        qualityRepo,
        promptRepo,
        promptExecutor,
        provider: aiProvider,
        provenanceRepo,
        gate: enrichmentGate,
        editionRepo,
        model: cfg.AI_TEXT_MODEL,
      });

      const embeddingRepo = createEmbeddingRepository(db);
      const embedWorker = createEmbedChunkWorker({
        chunkRepo,
        embeddingRepo,
        embeddingProvider,
        provenanceRepo,
        gate: enrichmentGate,
        editionRepo,
      });

      const storyRepo = createStoryRepository(db);
      const signalRepo = createSignalRepository(db);
      const sourceTrustRepo = createSourceTrustRepository(db);

      const clusterStoriesWorker = createClusterStoriesWorker({
        docRepo,
        summaryRepo,
        topicRepo,
        embeddingRepo,
        storyRepo,
        provenanceRepo,
        signalRepo,
        sourceTrustRepo,
        enrichmentTracker: createEnrichmentTrackerRepository(db),
        youtubeFocusChannels,
        options: {
          ...(cfg.DIGEST_SMALL_EDITION_MAX_DOCUMENTS !== undefined
            ? { smallEditionMaxDocuments: cfg.DIGEST_SMALL_EDITION_MAX_DOCUMENTS }
            : {}),
          ...(cfg.DIGEST_SMALL_EDITION_SIMILARITY_THRESHOLD !== undefined
            ? {
                smallEditionSimilarityThreshold:
                  cfg.DIGEST_SMALL_EDITION_SIMILARITY_THRESHOLD,
              }
            : {}),
        },
      });

      const summarizeStoryWorker = createSummarizeStoryWorker({
        storyRepo,
        storySummaryRepo: createStorySummaryRepository(db),
        docRepo,
        chunkRepo,
        summaryRepo,
        promptRepo,
        promptExecutor,
        provider: aiProvider,
        provenanceRepo,
        signalRepo,
        youtubeFocusChannels,
        model: cfg.AI_TEXT_MODEL,
      });

      const runtime = createWorkerRuntime({
        db,
        queue,
        workers: [
          expandWorker,
          chunkWorker,
          summaryWorker,
          entitiesWorker,
          topicsWorker,
          qualityWorker,
          embedWorker,
          clusterStoriesWorker,
          summarizeStoryWorker,
        ],
        logger: createLogger({ baseFields: { worker: "runtime" } }),
        retry: {
          maxAttempts: resolvePositiveInt(cfg.RETRY_MAX_ATTEMPTS, 5, 20),
        },
      });

      const workerConcurrency = resolveWorkerConcurrency(cfg.WORKER_CONCURRENCY);
      const processLogger = createLogger({ baseFields: { worker: "process" } });

      const STALE_LOCK_THRESHOLD_MS = 30 * 60 * 1000;
      const recovered = await queue.recoverStaleJobs(STALE_LOCK_THRESHOLD_MS);
      if (recovered > 0) {
        processLogger.info("recovered stale running jobs at start of drain", {
          recovered,
          thresholdMs: STALE_LOCK_THRESHOLD_MS,
        });
      }

      const requeuedClusters = await reconcileMissingClusterJobs(db);
      if (requeuedClusters > 0) {
        processLogger.info("requeued cluster jobs for fully enriched editions with unclustered documents", {
          editionCount: requeuedClusters,
        });
      }

      const processedByWorker = await Promise.all(
        Array.from({ length: workerConcurrency }, async (_, index) => {
          const workerId = `cli-worker-${index + 1}`;
          let processed = 0;
          let connectionRetries = 0;
          for (;;) {
            try {
              while (await runtime.runOne(workerId)) {
                processed++;
              }
              return processed;
            } catch (err) {
              connectionRetries++;
              if (connectionRetries > 3) throw err;
              const delayMs = connectionRetries * 1000;
              processLogger.warn("worker loop failed; retrying", {
                workerId,
                retry: connectionRetries,
                delayMs,
                error: err as Error,
              });
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        }),
      );
      const processed = processedByWorker.reduce((total, count) => total + count, 0);
      console.log(`Processed ${processed} jobs. Queue is empty.`);
      return 0;
    }

    if (command === "maintenance") {
      const queue = createProcessingJobQueue(db);
      const notebookLm = createNotebookLmClient({});
      const parsed = parseMaintenanceFlags({ args: rest });
      if (parsed.help) {
        console.log(MAINTENANCE_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(MAINTENANCE_HELP);
        return 2;
      }
      await runMaintenance({
        db,
        notebookLm,
        queue,
        options: parsed.options,
        log: (m) => console.log(m),
      });
      return 0;
    }

    if (command === "generate-digest") {
      const parsed = parseGenerateDigestFlags({ args: rest });
      if (parsed.help) {
        console.log(GENERATE_DIGEST_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(GENERATE_DIGEST_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "generate-digest" } });
      const editionRepo = createEditionRepository(db);
      const docRepo = createDocumentRepository(db);
      const storyRepo = createStoryRepository(db);
      const storySummaryRepo = createStorySummaryRepository(db);
      const topicRepo = createTopicRepository(db);
      const chunkRepo = createChunkRepository(db);
      const digestRepo = createMarkdownDigestRepository(db);
      const assembly = createEditionAssemblyService({
        db,
        editionRepo,
        storyRepo,
        storySummaryRepo,
        enrichmentTracker: createEnrichmentTrackerRepository(db),
      });
      const service = createMarkdownDigestService({
        db,
        editionRepo,
        assembly,
        storySummaryRepo,
        docRepo,
        chunkRepo,
        topicRepo,
        digestRepo,
        signalRepo: createSignalRepository(db),
        presentation: {
          targetReadingMinutes: cfg.DIGEST_TARGET_READING_MINUTES,
          quietEditionReason: cfg.DIGEST_QUIET_EDITION_REASON,
        },
        logger,
      });
      const { exitCode } = await runGenerateDigestCommand({
        service,
        editionDate: parsed.editionDate,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "generate-email") {
      const parsed = parseGenerateEmailFlags({ args: rest });
      if (parsed.help) {
        console.log(GENERATE_EMAIL_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(GENERATE_EMAIL_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "generate-email" } });
      const apiKey = cfg.RESEND_API_KEY ?? "";
      const fromAddress = cfg.EMAIL_FROM ?? "";
      const toAddresses = cfg.EMAIL_RECIPIENT
        ? cfg.EMAIL_RECIPIENT.split(/[,;\s]+/).filter((s) => s.length > 0)
        : [];
      if (!apiKey || !fromAddress) {
        console.log(
          "RESEND_API_KEY and EMAIL_FROM are required for generate-email",
        );
        return 1;
      }
      const editionRepo = createEditionRepository(db);
      const markdownDigestRepo = createMarkdownDigestRepository(db);
      const emailDigestRepo = createEmailDigestRepository(db);
      const resend = createResendClient({ apiKey });
      const service = createEmailDigestService({
        db,
        editionRepo,
        markdownDigestRepo,
        emailDigestRepo,
        resend,
        config: { fromAddress, toAddresses },
        logger,
      });
      const { exitCode } = await runGenerateEmailCommand({
        service,
        editionDate: parsed.editionDate,
        dryRun: parsed.dryRun,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "generate-notebook") {
      const parsed = parseGenerateNotebookFlags({ args: rest });
      if (parsed.help) {
        console.log(GENERATE_NOTEBOOK_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(GENERATE_NOTEBOOK_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "generate-notebook" } });
      const editionRepo = createEditionRepository(db);
      const docRepo = createDocumentRepository(db);
      const notebookRepo = createNotebookRepository(db);
      const notebookLm = createNotebookLmClient({});
      const signalRepo = createSignalRepository(db);
      const service = createNotebookService({
        db,
        editionRepo,
        docRepo,
        notebookRepo,
        notebookLm,
        signalRepo,
        config: {
          maxSourcesPerNotebook: cfg.NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK,
          partitionMinArticles:
            parsePartitionConfig(cfg.PARTITION_CONFIG)[parsed.partitionKey ?? "master"]
              ?.min_articles,
        },
        logger,
      });
      const { exitCode } = await runGenerateNotebookCommand({
        service,
        editionDate: parsed.editionDate,
        partitionKey: parsed.partitionKey,
        wait: parsed.wait,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "generate-podcast") {
      const parsed = parseGeneratePodcastFlags({ args: rest });
      if (parsed.help) {
        console.log(GENERATE_PODCAST_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(GENERATE_PODCAST_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "generate-podcast" } });
      const editionRepo = createEditionRepository(db);
      const markdownDigestRepo = createMarkdownDigestRepository(db);
      const notebookRepo = createNotebookRepository(db);
      const podcastRepo = createPodcastRepository(db);
      const notebookLm = createNotebookLmClient({});
      const service = createPodcastService({
        db,
        editionRepo,
        markdownDigestRepo,
        notebookRepo,
        podcastRepo,
        notebookLm,
        config: { outputDir: cfg.NOTEBOOKLM_OUTPUT_DIR },
        logger,
      });
      const { exitCode } = await runGeneratePodcastCommand({
        service,
        editionDate: parsed.editionDate,
        partitionKey: parsed.partitionKey,
        wait: parsed.wait,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "publish-edition") {
      const parsed = parsePublishEditionFlags({ args: rest });
      if (parsed.help) {
        console.log(PUBLISH_EDITION_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(PUBLISH_EDITION_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "publish-edition" } });
      const editionRepo = createEditionRepository(db);
      const markdownDigestRepo = createMarkdownDigestRepository(db);
      const emailDigestRepo = createEmailDigestRepository(db);
      const notebookRepo = createNotebookRepository(db);
      const podcastRepo = createPodcastRepository(db);
      const queue = createProcessingJobQueue(db);
      const partitionConfig = parsePartitionConfig(cfg.PARTITION_CONFIG);
      const service = createPublicationService({
        db,
        editionRepo,
        markdownDigestRepo,
        emailDigestRepo,
        notebookRepo,
        podcastRepo,
        jobQueue: queue,
        partitionConfig,
        logger,
      });
      const { exitCode } = await runPublishEditionCommand({
        service,
        editionLookup: editionRepo,
        db,
        partitionConfig,
        editionDate: parsed.editionDate,
        dryRun: parsed.dryRun,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "generate-edition") {
      const parsed = parseGenerateEditionFlags({ args: rest });
      if (parsed.help) {
        console.log(GENERATE_EDITION_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(GENERATE_EDITION_HELP);
        return 2;
      }

      const logger = createLogger({ baseFields: { worker: "generate-edition" } });
      const editionRepo = createEditionRepository(db);
      const storyRepo = createStoryRepository(db);
      const storySummaryRepo = createStorySummaryRepository(db);
      const enrichmentTracker = createEnrichmentTrackerRepository(db);
      const assembly = createEditionAssemblyService({
        db,
        editionRepo,
        storyRepo,
        storySummaryRepo,
        enrichmentTracker,
      });
      const readinessGate = createEditionReadinessGate({
        db,
        editionRepo,
        assembly,
      });
      const { exitCode } = await runGenerateEditionCommand({
        editionRepo,
        readinessGate,
        editionDate: parsed.editionDate,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "retry") {
      const parsed = parseRetryFlags({ args: rest });
      if (parsed.help) {
        console.log(RETRY_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(RETRY_HELP);
        return 2;
      }
      const queue = createProcessingJobQueue(db);
      const { exitCode } = await runRetryCommand({
        queue,
        filters: parsed.filters,
        dryRun: parsed.dryRun,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "doctor") {
      console.log(DOCTOR_HELP);
      const queue = createProcessingJobQueue(db);
      const miniflux =
        cfg.MINIFLUX_URL && cfg.MINIFLUX_API_TOKEN
          ? createMinifluxClient({
              baseUrl: cfg.MINIFLUX_URL,
              token: cfg.MINIFLUX_API_TOKEN,
            })
          : undefined;
      const notebookLm = createNotebookLmClient({});
      const { exitCode } = await runDoctorCommand({
        config: cfg,
        pool,
        queue,
        miniflux,
        notebookLm,
        resendApiKey: cfg.RESEND_API_KEY,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "metrics") {
      const parsed = parseMetricsFlags({ args: rest });
      if (parsed.help) {
        console.log(METRICS_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(METRICS_HELP);
        return 2;
      }
      const queue = createProcessingJobQueue(db);
      const { exitCode } = await runMetricsCommand({
        db,
        queue,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "partitions") {
      const parsed = parsePartitionsFlags({ args: rest });
      if (parsed.help) {
        console.log(PARTITIONS_HELP);
        return 0;
      }
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) console.error(e);
        console.log(PARTITIONS_HELP);
        return 2;
      }
      const { exitCode } = await runPartitionsCommand({
        db,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "active-partitions") {
      const editionDate = parseActivePartitionsDate(rest);
      if (!editionDate) {
        console.error("Usage: digestive active-partitions --date <YYYY-MM-DD>");
        return 2;
      }
      const editionRepo = createEditionRepository(db);
      const partitionConfig = parsePartitionConfig(cfg.PARTITION_CONFIG);
      const { exitCode } = await runActivePartitionsCommand({
        editionDate,
        partitionConfig,
        resolveEditionId: async (date) => (await editionRepo.getByDate(date))?.id,
        resolveActivePartitions: (editionId, config) =>
          getActivePartitions({ db: db!, editionId, config }),
        log: (line) => console.log(line),
      });
      return exitCode;
    }

    if (command === "feedback") {
      const signalRepo = createSignalRepository(db);
      const editionRepo = createEditionRepository(db);
      const storyRepo = createStoryRepository(db);
      const docRepo = createDocumentRepository(db);
      const chunkRepo = createChunkRepository(db);
      if (rest[0] === "--help" || rest[0] === "-h" || rest[0] === undefined) {
        console.log(FEEDBACK_HELP);
        return rest[0] === undefined ? 2 : 0;
      }
      const { exitCode } = await runFeedbackCommand({
        signalRepo,
        editionRepo,
        storyRepo,
        docRepo,
        chunkRepo,
        args: rest,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "source-trust") {
      const repo = createSourceTrustRepository(db);
      if (rest[0] === "--help" || rest[0] === "-h" || rest[0] === undefined) {
        console.log(SOURCE_TRUST_HELP);
        return rest[0] === undefined ? 2 : 0;
      }
      const { exitCode } = await runSourceTrustCommand({
        repo,
        args: rest,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    if (command === "feedback-summary") {
      if (rest[0] === "--help" || rest[0] === "-h") {
        console.log(FEEDBACK_SUMMARY_HELP);
        return 0;
      }
      const signalRepo = createSignalRepository(db);
      const { exitCode } = await runFeedbackSummaryCommand({
        db,
        signalRepo,
        args: rest,
        log: (m) => console.log(m),
      });
      return exitCode;
    }

    console.log(
      "Usage: digestive <command>\nCommands: discover, process, maintenance, generate-digest, generate-email, generate-notebook, generate-podcast, publish-edition, generate-edition, retry, doctor, metrics, partitions, feedback, feedback-summary, source-trust",
    );
    return 2;
  } finally {
    if (db) await closeKysely(db);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
