import { Kysely, Transaction, sql } from "kysely";
import type { Database } from "../database/kysely.js";
import type { EnqueueJobInput } from "../jobs/workers/worker.js";
import {
  type EnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
  assertValidEnrichmentType,
  getDocumentEnrichmentCompletion,
} from "./enrichment-tracker-repository.js";

const CLUSTER_STORIES_JOB_TYPE = "cluster_stories";

export interface EnrichmentGateServiceDeps {
  db: Kysely<Database>;
  tracker: EnrichmentTrackerRepository;
}

export interface EnrichmentGateService {
  markEnrichmentDoneAndMaybeEnqueueCluster(
    editionId: string,
    documentId: string,
    enrichmentType: string,
    chunkId?: string,
  ): Promise<EnqueueJobInput | null>;
}

interface TrackedCounts {
  totalDocuments: number;
  fullyEnrichedDocuments: number;
}

async function countFullyEnrichedInTransaction(
  trx: Transaction<Database>,
  editionId: string,
): Promise<TrackedCounts> {
  const documents = await trx
    .selectFrom("documents")
    .select("id")
    .where("edition_id", "=", editionId)
    .execute();
  const totalDocuments = documents.length;

  if (totalDocuments === 0) {
    return { totalDocuments: 0, fullyEnrichedDocuments: 0 };
  }

  let fullyEnrichedDocuments = 0;
  for (const document of documents) {
    const completion = await getDocumentEnrichmentCompletion(trx, document.id);
    if (completion.completedTypes.length === REQUIRED_ENRICHMENT_TYPES.length) {
      fullyEnrichedDocuments += 1;
    }
  }

  return { totalDocuments, fullyEnrichedDocuments };
}

async function documentEnrichmentHasCompletedAllChunks(
  trx: Transaction<Database>,
  editionId: string,
  documentId: string,
  enrichmentType: string,
  currentChunkId: string,
): Promise<boolean> {
  const totalRow = await trx
    .selectFrom("document_chunks")
    .select((eb) => eb.fn.count<number>("id").as("total"))
    .where("document_id", "=", documentId)
    .executeTakeFirstOrThrow();
  const totalChunks = Number(totalRow.total);
  if (totalChunks === 0) return false;

  const completedRows = await sql<{ chunk_id: string }>`
    SELECT DISTINCT target->>'chunkId' AS chunk_id
    FROM processing_jobs
    WHERE edition_id = ${editionId}
      AND job_type = ${enrichmentType}
      AND status IN ('completed', 'archived')
      AND target->>'documentId' = ${documentId}
      AND target ? 'chunkId'
  `.execute(trx);
  const completedChunkIds = new Set(
    completedRows.rows
      .map((row) => row.chunk_id)
      .filter((chunkId): chunkId is string => typeof chunkId === "string"),
  );
  // The worker calls this before the runtime transaction marks its own job
  // completed, so account for the successful current chunk explicitly.
  completedChunkIds.add(currentChunkId);
  return completedChunkIds.size >= totalChunks;
}

async function claimEditionForClusterInTransaction(
  trx: Transaction<Database>,
  editionId: string,
): Promise<Date | null> {
  const activeClusterJob = await trx
    .selectFrom("processing_jobs")
    .select("id")
    .where("edition_id", "=", editionId)
    .where("job_type", "=", CLUSTER_STORIES_JOB_TYPE)
    .where("status", "in", ["pending", "running"])
    .executeTakeFirst();
  if (activeClusterJob) return null;

  const updated = await trx
    .updateTable("editions")
    .set({
      cluster_stories_enqueued_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", editionId)
    .where("cluster_stories_enqueued_at", "is", null)
    .returning(["cluster_stories_enqueued_at"])
    .executeTakeFirst();
  return updated?.cluster_stories_enqueued_at ?? null;
}

async function markDoneInTransaction(
  trx: Transaction<Database>,
  documentId: string,
  enrichmentType: string,
): Promise<void> {
  await trx
    .insertInto("document_enrichment_status")
    .values({
      document_id: documentId,
      enrichment_type: enrichmentType,
      status: "done",
      completed_at: sql<Date>`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["document_id", "enrichment_type"]).doUpdateSet({
        status: "done",
        completed_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      }),
    )
    .execute();
}

export function createEnrichmentGateService(
  deps: EnrichmentGateServiceDeps,
): EnrichmentGateService {
  return {
    async markEnrichmentDoneAndMaybeEnqueueCluster(
      editionId,
      documentId,
      enrichmentType,
      chunkId,
    ) {
      assertValidEnrichmentType(enrichmentType);

      return deps.db.transaction().execute(async (trx) => {
        if (
          chunkId !== undefined &&
          !(await documentEnrichmentHasCompletedAllChunks(
            trx,
            editionId,
            documentId,
            enrichmentType,
            chunkId,
          ))
        ) {
          return null;
        }
        await markDoneInTransaction(trx, documentId, enrichmentType);

        const counts = await countFullyEnrichedInTransaction(trx, editionId);
        if (counts.totalDocuments === 0) return null;
        if (counts.fullyEnrichedDocuments !== counts.totalDocuments) return null;

        const claimedAt = await claimEditionForClusterInTransaction(trx, editionId);
        if (claimedAt === null) return null;

        return {
          jobType: CLUSTER_STORIES_JOB_TYPE,
          editionId,
          target: { editionId },
        } satisfies EnqueueJobInput;
      });
    },
  };
}
