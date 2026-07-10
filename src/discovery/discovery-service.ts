import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import type { Edition } from "../database/kysely.js";
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

const MUTABLE_EDITION_STATUSES = new Set<Edition["status"]>([
  "building",
  "failed",
]);

function editionDateKey(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function nextEditionDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function resolveOpenEdition(
  editionRepo: EditionRepository,
  requestedDate: string | Date,
): Promise<{ edition: Edition; requestedDate: string; selectedDate: string }> {
  const requestedDateKey = editionDateKey(requestedDate);
  let selectedDate = requestedDateKey;

  // A published/ready/publishing edition is immutable for discovery. Walk
  // forward until we find an existing mutable edition or create the next one.
  // This keeps late-arriving entries out of a digest that has already shipped.
  for (let attempts = 0; attempts < 3660; attempts++) {
    const existing = await editionRepo.getByDate(selectedDate);
    if (!existing) {
      return {
        edition: await editionRepo.getOrCreateForDate(selectedDate),
        requestedDate: requestedDateKey,
        selectedDate,
      };
    }
    if (MUTABLE_EDITION_STATUSES.has(existing.status)) {
      return { edition: existing, requestedDate: requestedDateKey, selectedDate };
    }
    selectedDate = nextEditionDate(selectedDate);
  }

  throw new Error(`could not find an open edition after ${requestedDateKey}`);
}

async function hasMinifluxReadReset(
  db: Kysely<Database>,
  editionId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("editions")
    .select("miniflux_read_reset_at")
    .where("id", "=", editionId)
    .executeTakeFirst();
  return row?.miniflux_read_reset_at !== null && row?.miniflux_read_reset_at !== undefined;
}

async function markMinifluxReadReset(
  db: Kysely<Database>,
  editionId: string,
): Promise<void> {
  await db
    .updateTable("editions")
    .set({ miniflux_read_reset_at: new Date() })
    .where("id", "=", editionId)
    .where("miniflux_read_reset_at", "is", null)
    .execute();
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
      const resolved = await resolveOpenEdition(deps.editionRepo, input.editionDate);
      const edition = resolved.edition;
      const editionLog = log?.child({ editionId: edition.id });

      if (resolved.selectedDate !== resolved.requestedDate) {
        editionLog?.info("routed discovery to next open edition", {
          requestedDate: resolved.requestedDate,
          selectedDate: resolved.selectedDate,
        });
      }

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

      if (!(await hasMinifluxReadReset(deps.db, edition.id))) {
        try {
          await input.miniflux.markAllFeedsRead();
          await markMinifluxReadReset(deps.db, edition.id);
          editionLog?.info("marked all Miniflux feeds read at edition boundary", {
            editionDate: resolved.selectedDate,
          });
        } catch (err) {
          // Ingestion remains successful if the read-state housekeeping call
          // fails. The null marker makes the next poll retry it.
          editionLog?.warn("could not mark all Miniflux feeds read", {
            error: err as Error,
            editionDate: resolved.selectedDate,
          });
        }
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
