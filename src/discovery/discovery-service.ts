import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import { createDiscoveryRepository } from "./discovery-repository.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { MinifluxClient } from "./miniflux-client.js";
import type { Logger } from "../logging/logger.js";
import type { PartitionConfig } from "../config/index.js";
import { resolvePartitionKey } from "./partition-resolver.js";
import { createMinifluxIngestionStateRepository } from "./miniflux-ingestion-state-repository.js";

export interface DiscoveryResult {
  editionId: string;
  total: number;
  created: number;
  duplicates: number;
  enqueued: number;
  failed: number;
}

export interface DiscoveryService {
  discover(input: {
    editionDate: string | Date;
    miniflux: MinifluxClient;
    limit?: number;
  }): Promise<DiscoveryResult>;
}

export function createDiscoveryService(deps: {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  discoveryRepo: DiscoveryRepository;
  queue: ProcessingJobQueue;
  partitionConfig?: PartitionConfig;
  logger?: Logger;
}): DiscoveryService {
  return {
    async discover(input) {
      const log = deps.logger?.child({ worker: "discovery" });
      const edition = await deps.editionRepo.getOrCreateForDate(input.editionDate);
      const editionLog = log?.child({ editionId: edition.id });

      const limit = input.limit ?? 100;
      let total = 0;
      let created = 0;
      let duplicates = 0;
      let enqueued = 0;
      let failed = 0;
      let afterEntryId: number | undefined;
      const ingestionState = createMinifluxIngestionStateRepository(deps.db);
      const savedState = await ingestionState.get();
      if (savedState) {
        afterEntryId = Number(savedState.last_entry_id);
      } else {
        // Avoid replaying entries already imported before the cursor table was
        // introduced. New entries are still selected regardless of read state.
        afterEntryId = await deps.discoveryRepo.getMaxMinifluxEntryId();
      }
      let runHadFailure = false;

      for (;;) {
        const listEntries = input.miniflux.listEntries ?? input.miniflux.listUnreadEntries;
        const entries = await listEntries.call(input.miniflux, {
          status: "all",
          limit,
          afterEntryId,
        });
        if (entries.length === 0) break;

        for (const entry of entries) {
          total++;
          let made = false;
          try {
            const partitionKey = resolvePartitionKey({
              entry,
              config: deps.partitionConfig,
            });
            await deps.db.transaction().execute(async (trx) => {
              const dr = createDiscoveryRepository(trx);
              const { event, created: c } = await dr.getOrCreate({
                editionId: edition.id,
                minifluxEntryId: entry.id,
                feedId: entry.feedId,
                title: entry.title,
                url: entry.url,
                hash: entry.hash,
                publishedAt: entry.publishedAt,
                metadata: { title: entry.title, feedId: entry.feedId },
                partitionKey,
              });
              if (c) {
                const q = createProcessingJobQueue(trx);
                await q.enqueue({
                  jobType: "expand_document",
                  editionId: edition.id,
                  target: { discoveryEventId: event.id, url: entry.url, partitionKey },
                });
                made = true;
              }
              // Advance the local cursor in the same transaction as the
              // event/job. If an earlier entry failed, leave the cursor at
              // the last contiguous success so that failed entries retry on
              // the next poll rather than being skipped.
              if (!runHadFailure) {
                await createMinifluxIngestionStateRepository(trx).set({
                  lastEntryId: entry.id,
                });
              }
            });
            if (made) {
              created++;
              enqueued++;
            } else {
              duplicates++;
            }
          } catch (err) {
            failed++;
            runHadFailure = true;
            editionLog?.error("discovery entry failed", {
              error: err as Error,
              minifluxEntryId: entry.id,
              url: entry.url,
            });
          }
          afterEntryId = entry.id;
        }

        if (entries.length < limit) break;
      }

      editionLog?.info("discovery complete", {
        total,
        created,
        duplicates,
        enqueued,
        failed,
      });
      return { editionId: edition.id, total, created, duplicates, enqueued, failed };
    },
  };
}
