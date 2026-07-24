import { sql, type Kysely, type SqlBool } from "kysely";
import type { Database, Edition } from "../database/kysely.js";
import type { Logger } from "../logging/logger.js";
import { type EditionRepository } from "./edition-repository.js";
import {
  getDocumentEnrichmentCompletionsForEdition,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";

export interface EditionRolloverResult {
  sourceEditionId: string;
  targetEditionId: string;
  movedDocumentCount: number;
  movedDiscoveryEventCount: number;
  movedJobCount: number;
  /** Jobs recreated for expanded documents whose prior chunk job was skipped. */
  requeuedJobCount?: number;
  cancelledJobCount: number;
  /** IDs of stories that became empty after the move and were deleted. */
  deletedStoryIds: string[];
}

export interface EditionRolloverService {
  rolloverUnreadyDocuments(editionId: string): Promise<EditionRolloverResult>;
}

export interface EditionRolloverDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  logger?: Logger;
}

// A ready edition is still repairable until the publication service moves it
// to publishing. This covers a boundary race from older deployments where a
// chunk job was marked complete after the edition became ready.
const ROLLOVER_EDITION_STATUSES = ["building", "failed", "ready"] as const;
const NEXT_MUTABLE_EDITION_STATUSES = ["building", "failed"] as const;

function nextDayUtc(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Extract the calendar date (YYYY-MM-DD) from a Date without applying the
 * server's local timezone. Postgres `date` columns are returned by node-pg as
 * JS Date objects constructed in the server's local timezone; using
 * `toISOString()` would silently shift the date by one in any non-UTC host.
 */
function formatDateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolve the next open mutable edition strictly after the given edition.
 *
 * Reuses the same forward-walk semantics as discovery: skip already-ready
 * / published editions and create the next building edition so the rolled
 * -over documents land in a fresh slot the drain can pick up.
 */
async function resolveOrCreateNextMutableEdition(
  db: Kysely<Database>,
  sourcePublicationDate: Date,
): Promise<Edition> {
  let cursor = formatDateOnly(sourcePublicationDate);
  for (let i = 0; i < 3660; i++) {
    cursor = nextDayUtc(cursor);
    const existing = await db
      .selectFrom("editions")
      .selectAll()
      .where(sql<SqlBool>`publication_date = ${cursor}::date`)
      .executeTakeFirst();
    if (!existing) {
      return db
        .insertInto("editions")
        .values({ publication_date: sql<Date>`${cursor}::date` })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if ((NEXT_MUTABLE_EDITION_STATUSES as readonly string[]).includes(existing.status)) {
      return existing;
    }
  }
  throw new Error(
    `could not find an open mutable edition after ${formatDateOnly(sourcePublicationDate)}`,
  );
}

export function createEditionRolloverService(
  deps: EditionRolloverDeps,
): EditionRolloverService {
  return {
    async rolloverUnreadyDocuments(editionId) {
      return deps.db.transaction().execute(async (trx) => {
        const source = await trx
          .selectFrom("editions")
          .selectAll()
          .where("id", "=", editionId)
          .forUpdate()
          .executeTakeFirst();
        if (!source) {
          throw new Error(`edition not found: ${editionId}`);
        }
        if (!(ROLLOVER_EDITION_STATUSES as readonly string[]).includes(source.status)) {
          deps.logger?.info("rollover noop: edition is not mutable", {
            editionId: source.id,
            status: source.status,
          });
          return {
            sourceEditionId: source.id,
            targetEditionId: source.id,
            movedDocumentCount: 0,
            movedDiscoveryEventCount: 0,
            movedJobCount: 0,
            cancelledJobCount: 0,
            deletedStoryIds: [],
          } satisfies EditionRolloverResult;
        }

        // Match the publication readiness gate: a document is publishable only
        // when it is fully enriched AND belongs to a story with a summary.
        // Looking only for a summary is insufficient after a chunk repair can
        // reset enrichment state while leaving an older story membership.
        const completions = await getDocumentEnrichmentCompletionsForEdition(
          trx,
          source.id,
        );
        const documentIds = [...completions.keys()];
        const summarizedDocumentIds = new Set<string>();
        if (documentIds.length > 0) {
          const summarizedRows = await trx
            .selectFrom("cluster_members as cm")
            .innerJoin("story_summaries as ss", "ss.story_id", "cm.story_id")
            .select("cm.document_id")
            .where("cm.document_id", "in", documentIds)
            .distinct()
            .execute();
          for (const row of summarizedRows) {
            summarizedDocumentIds.add(row.document_id);
          }
        }
        const movedDocumentIds = documentIds.filter((documentId) => {
          const fullyEnriched =
            (completions.get(documentId)?.completedTypes.length ?? 0) ===
            REQUIRED_ENRICHMENT_TYPES.length;
          return !fullyEnriched || !summarizedDocumentIds.has(documentId);
        });
        if (movedDocumentIds.length === 0) {
          deps.logger?.info("rollover noop: every document is ready", {
            editionId: source.id,
          });
          return {
            sourceEditionId: source.id,
            movedDocumentCount: 0,
            targetEditionId: source.id,
            movedDiscoveryEventCount: 0,
            movedJobCount: 0,
            cancelledJobCount: 0,
            deletedStoryIds: [],
          } satisfies EditionRolloverResult;
        }

        const target = await resolveOrCreateNextMutableEdition(trx, source.publication_date);

        // Stories that will lose at least one member. We collect their ids
        // before the move so we can clean up stories that end up empty.
        const affectedStoryRows = await trx
          .selectFrom("story_clusters as sc")
          .innerJoin("cluster_members as cm", "cm.story_id", "sc.id")
          .select(["sc.id as story_id"])
          .where("sc.edition_id", "=", source.id)
          .where("cm.document_id", "in", movedDocumentIds)
          .distinct()
          .execute();
        const affectedStoryIds = affectedStoryRows.map((r) => r.story_id);

        // Re-target document-scoped jobs to the new edition. Failed child jobs
        // move too so a later retry command can scope them to the target day.
        // The processing queue claims work by edition_id, so jobs that stay
        // on the source edition would never be picked up by tomorrow's drain.
        // We match on documentId without scoping to the source edition: jobs
        // associated with the moved documents that already escaped the source
        // (for example, jobs re-enqueued after the document moved) also need
        // to follow. The cancel-counter below reflects any rows that the
        // batch UPDATE found but could not move to the target edition.
        const movedJobs = await trx
          .updateTable("processing_jobs")
          .set({ edition_id: target.id, updated_at: sql<Date>`now()` })
          .where(
            sql`target->>'documentId'`,
            "in",
            movedDocumentIds,
          )
          .where("status", "in", ["pending", "running", "failed"])
          .returning(["id"])
          .execute();

        // A previous boundary race can have marked chunk_document complete
        // after the source edition became ready. Such a job is not claimable
        // again, while the expanded document still has sections but no chunks
        // or enrichment jobs. Recreate only the missing chunk job; the
        // NOT EXISTS guard keeps this idempotent across reruns.
        const movedDocumentIdSql = sql.join(movedDocumentIds.map((id) => sql`${id}`));
        const requeuedChunkJobs = await sql<{ id: string }>`
          INSERT INTO processing_jobs
            (job_type, edition_id, target, status, next_eligible_at)
          SELECT
            'chunk_document',
            ${target.id},
            jsonb_build_object('documentId', d.id::text),
            'pending',
            now()
          FROM documents d
          WHERE d.id IN (${movedDocumentIdSql})
            AND EXISTS (
              SELECT 1 FROM document_sections s WHERE s.document_id = d.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM document_chunks c WHERE c.document_id = d.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM processing_jobs pj
              WHERE pj.job_type = 'chunk_document'
                AND pj.status IN ('pending', 'running')
                AND pj.target->>'documentId' = d.id::text
            )
          RETURNING id
        `.execute(trx);

        // Move the documents themselves. Document-scoped rows (sections,
        // chunks, enrichment data, embeddings) follow via their foreign key
        // to documents.
        await trx
          .updateTable("documents")
          .set({ edition_id: target.id })
          .where("id", "in", movedDocumentIds)
          .execute();

        // Drop the cluster_members rows that reference moved documents. The
        // story itself stays in the source edition; only its membership of
        // the moved document is severed. Stories that lose all of their
        // members become empty and are deleted below.
        await trx
          .deleteFrom("cluster_members")
          .where("document_id", "in", movedDocumentIds)
          .execute();

        // Move the discovery events for the moved documents. We match by
        // source_url since the discovery_event -> document link is via the
        // expansion job target, not a foreign key.
        const movedDocumentUrls = await trx
          .selectFrom("documents")
          .select("source_url")
          .where("id", "in", movedDocumentIds)
          .execute();
        const movedUrls = movedDocumentUrls.map((r) => r.source_url);
        let movedDiscoveryEventCount = 0;
        if (movedUrls.length > 0) {
          const movedDiscoveryEvents = await trx
            .updateTable("discovery_events")
            .set({ edition_id: target.id })
            .where("edition_id", "=", source.id)
            .where("url", "in", movedUrls)
            .returning(["id"])
            .execute();
          movedDiscoveryEventCount = movedDiscoveryEvents.length;
        }

        // Clean up stories that have lost all of their members. A story with
        // no documents is not a story — it would only generate empty
        // summaries downstream.
        const emptyStoryRows = affectedStoryIds.length === 0
          ? []
          : await trx
              .selectFrom("story_clusters as sc")
              .leftJoin("cluster_members as cm", "cm.story_id", "sc.id")
              .select(["sc.id as story_id"])
              .where("sc.id", "in", affectedStoryIds)
              .groupBy("sc.id")
              .having((eb) => eb.fn.count("cm.id"), "=", 0)
              .execute();
        const emptyStoryIds = emptyStoryRows.map((r) => r.story_id);
        if (emptyStoryIds.length > 0) {
          await trx
            .deleteFrom("story_clusters")
            .where("id", "in", emptyStoryIds)
            .execute();
        }

        // Clear the cluster-stories enqueue timestamp on the source edition so
        // a future reconcile pass does not re-cluster a now-partial snapshot.
        await trx
          .updateTable("editions")
          .set({ cluster_stories_enqueued_at: null, updated_at: sql<Date>`now()` })
          .where("id", "=", source.id)
          .execute();

        const result: EditionRolloverResult = {
          sourceEditionId: source.id,
          targetEditionId: target.id,
          movedDocumentCount: movedDocumentIds.length,
          movedDiscoveryEventCount,
          movedJobCount: movedJobs.length,
          requeuedJobCount: requeuedChunkJobs.rows.length,
          cancelledJobCount: 0,
          deletedStoryIds: emptyStoryIds,
        };

        deps.logger?.info("rolled unready documents to next edition", {
          ...result,
          sourcePublicationDate: formatDateOnly(source.publication_date),
          targetPublicationDate: formatDateOnly(target.publication_date),
        });

        return result;
      });
    },
  };
}
