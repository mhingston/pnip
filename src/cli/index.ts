import { loadConfig } from "../config/index.js";
import { createPool, closePool } from "../database/pool.js";
import { runMigrations } from "../database/migrations.js";
import { createKysely, closeKysely } from "../database/kysely.js";
import { createMinifluxClient } from "../discovery/miniflux-client.js";
import { createEditionRepository } from "../editions/edition-repository.js";
import { createDiscoveryRepository } from "../discovery/discovery-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import { createDiscoveryService } from "../discovery/discovery-service.js";
import { createLogger } from "../logging/logger.js";
import { createWorkerRuntime } from "../jobs/workers/worker-runtime.js";
import { createExpandDocumentWorker } from "../expansion/expand-document-worker.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createProvenanceRepository } from "../provenance/provenance-repository.js";
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
      const docRepo = createDocumentRepository(db);
      const sectionRepo = createSectionRepository(db);
      const provenanceRepo = createProvenanceRepository(db);

      const registry = buildPluginRegistry();

      const queue = createProcessingJobQueue(db);
      const expandWorker = createExpandDocumentWorker({
        docRepo,
        sectionRepo,
        pluginRegistry: registry,
        provenanceRepo,
        queue,
      });

      const runtime = createWorkerRuntime({
        db,
        queue,
        workers: [expandWorker],
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
