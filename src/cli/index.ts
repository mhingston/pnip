import { loadConfig } from "../config/index.js";
import { createPool, closePool } from "../database/pool.js";
import { runMigrations } from "../database/migrations.js";
import { createKysely, closeKysely } from "../database/kysely.js";
import { createMinifluxClient } from "../discovery/miniflux-client.js";
import { createEditionRepository } from "../editions/edition-repository.js";
import { createEnrichmentTrackerRepository } from "../editions/enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "../editions/enrichment-gate-service.js";
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
import { buildPluginRegistry } from "./process-registry.js";
import { parseCommand } from "./args.js";
import { runDiscoverCommand } from "./discover.js";

async function main(): Promise<number> {
  const cfg = loadConfig();

  const pool = createPool(cfg.DATABASE_URL);
  let db;
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
      const service = createDiscoveryService({
        db,
        editionRepo,
        discoveryRepo,
        queue,
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
        ],
        logger: createLogger({ baseFields: { worker: "runtime" } }),
      });

      const workerId = "cli-worker";
      let processed = 0;
      while (await runtime.runOne(workerId)) {
        processed++;
      }
      console.log(`Processed ${processed} jobs. Queue is empty.`);
      return 0;
    }

    console.log("Usage: digestive <command>\nCommands: discover, process");
    return 2;
  } finally {
    if (db) await closeKysely(db);
    await closePool(pool);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
