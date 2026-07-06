import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import { createDiscoveryRepository } from "./discovery-repository.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { MinifluxClient } from "./miniflux-client.js";
import type { Logger } from "../logging/logger.js";

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

      for (;;) {
        const entries = await input.miniflux.listUnreadEntries({
          limit,
          afterEntryId,
        });
        if (entries.length === 0) break;

        for (const entry of entries) {
          total++;
          let made = false;
          try {
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
              });
              if (c) {
                const q = createProcessingJobQueue(trx);
                await q.enqueue({
                  jobType: "expand_document",
                  editionId: edition.id,
                  target: { discoveryEventId: event.id, url: entry.url },
                });
                made = true;
              }
            });
            if (made) {
              created++;
              enqueued++;
            } else {
              duplicates++;
            }
            await input.miniflux.markEntryRead(entry.id);
          } catch (err) {
            failed++;
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
