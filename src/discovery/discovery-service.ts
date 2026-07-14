import { sql, type Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import type { Edition } from "../database/kysely.js";
import { createDiscoveryRepository } from "./discovery-repository.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import { createProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { MinifluxClient, MinifluxEntry } from "./miniflux-client.js";
import type { Logger } from "../logging/logger.js";
import type { PartitionConfig } from "../config/index.js";
import { resolvePartitionKey } from "./partition-resolver.js";
import { createMinifluxIngestionStateRepository } from "./miniflux-ingestion-state-repository.js";
import {
  classifyDiscoverySourceFamily,
  selectBalancedEntries,
} from "./source-coverage.js";

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
    /** Minimum discovery events to aim for in the mutable edition. */
    minimumEntries?: number;
    /** Historical window used only when the cursor has too few entries. */
    lookbackDays?: number;
    /** Prefer articles and YouTube over Reddit while filling the historical gap. */
    sourceBalance?: boolean;
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
  /** Runtime target supplied by the CLI; omitted for legacy/test callers. */
  minimumEntries?: number;
  lookbackDays?: number;
  sourceBalance?: boolean;
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
      let backfilled = 0;
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

      const processEntry = async (
        entry: MinifluxEntry,
        advanceCursor: boolean,
      ): Promise<"created" | "duplicate" | "failed"> => {
        let outcome: "created" | "duplicate" = "duplicate";
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
              metadata: {
                title: entry.title,
                feedId: entry.feedId,
                sourceFamily: classifyDiscoverySourceFamily(entry.url),
              },
              partitionKey,
            });
            if (c) {
              // A late discovery invalidates any cluster snapshot that was
              // queued for this still-mutable edition. The cluster worker
              // will defer until the new document is fully enriched.
              await trx
                .updateTable("editions")
                .set({
                  cluster_stories_enqueued_at: null,
                  updated_at: sql<Date>`now()`,
                })
                .where("id", "=", edition.id)
                .where("cluster_stories_enqueued_at", "is not", null)
                .execute();
              const q = createProcessingJobQueue(trx);
              await q.enqueue({
                jobType: "expand_document",
                editionId: edition.id,
                target: { discoveryEventId: event.id, url: entry.url, partitionKey },
              });
              outcome = "created";
            }
            // Historical fill candidates intentionally do not move the
            // monotonic cursor backward. New entries advance it atomically
            // with the event/job so a failed entry is retried next poll.
            if (advanceCursor && !runHadFailure) {
              await createMinifluxIngestionStateRepository(trx).set({
                lastEntryId: entry.id,
              });
            }
          });
          return outcome;
        } catch (err) {
          runHadFailure = true;
          editionLog?.error("discovery entry failed", {
            error: err as Error,
            minifluxEntryId: entry.id,
            url: entry.url,
            historicalFill: !advanceCursor,
          });
          failed++;
          return "failed";
        }
      };

      const listEntries = input.miniflux.listEntries ?? input.miniflux.listUnreadEntries;
      for (;;) {
        const entries = await listEntries.call(input.miniflux, {
          status: "all",
          limit,
          afterEntryId,
        });
        if (entries.length === 0) break;

        for (const entry of entries) {
          total++;
          const outcome = await processEntry(entry, true);
          if (outcome === "created") {
            created++;
            enqueued++;
          } else if (outcome === "duplicate") {
            duplicates++;
          }
          afterEntryId = entry.id;
        }

        if (entries.length < limit) break;
      }

      const minimumEntries = Math.max(
        0,
        Math.floor(input.minimumEntries ?? deps.minimumEntries ?? 0),
      );
      const editionEntryCount = await deps.discoveryRepo.countByEdition(edition.id);
      const needed = Math.max(0, minimumEntries - editionEntryCount);
      const lookbackDays = Math.max(
        0,
        Math.floor(input.lookbackDays ?? deps.lookbackDays ?? 7),
      );
      if (needed > 0 && lookbackDays > 0) {
        const historicalLimit = Math.min(
          500,
          Math.max(limit, needed * 4),
        );
        const cutoff = new Date(`${resolved.selectedDate}T00:00:00.000Z`);
        cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
        const unprocessed: MinifluxEntry[] = [];
        let historicalBeforeEntryId = afterEntryId;
        for (let page = 0; page < 5 && unprocessed.length < needed; page++) {
          const historicalEntries = await listEntries.call(input.miniflux, {
            status: "all",
            limit: historicalLimit,
            beforeEntryId: historicalBeforeEntryId,
            direction: "desc",
          });
          if (historicalEntries.length === 0) break;
          for (const entry of historicalEntries) {
            const timestamp = entry.publishedAt ?? entry.createdAt;
            if (timestamp && new Date(timestamp) < cutoff) continue;
            if (await deps.discoveryRepo.getByMinifluxEntryId(entry.id)) continue;
            unprocessed.push(entry);
          }
          const lowestEntryId = Math.min(...historicalEntries.map((entry) => entry.id));
          if (!Number.isFinite(lowestEntryId)) break;
          historicalBeforeEntryId = lowestEntryId;
          if (historicalEntries.length < historicalLimit) break;
        }
        const candidates = selectBalancedEntries(
          unprocessed,
          needed,
          input.sourceBalance ?? deps.sourceBalance ?? true,
        );
        editionLog?.info("filling edition from recent unprocessed entries", {
          needed,
          candidates: candidates.length,
          lookbackDays,
          sourceBalance: input.sourceBalance ?? deps.sourceBalance ?? true,
        });
        for (const entry of candidates) {
          total++;
          const outcome = await processEntry(entry, false);
          if (outcome === "created") {
            created++;
            enqueued++;
            backfilled++;
          }
        }
      }

      if (minimumEntries > 0) {
        const finalEditionEntryCount = await deps.discoveryRepo.countByEdition(edition.id);
        if (finalEditionEntryCount < minimumEntries) {
          editionLog?.warn("edition is below the configured discovery target", {
            targetEntries: minimumEntries,
            discoveredEntries: finalEditionEntryCount,
            shortfall: minimumEntries - finalEditionEntryCount,
            lookbackDays,
          });
        }
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
        backfilled,
      });
      return { editionId: edition.id, total, created, duplicates, enqueued, failed };
    },
  };
}
