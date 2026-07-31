import { Kysely, Transaction, sql } from "kysely";
import type { Database } from "../database/kysely.js";
import {
  type EnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
  assertValidEnrichmentType,
  getDocumentEnrichmentCompletionsForEdition,
} from "./enrichment-tracker-repository.js";

export interface EnrichmentGateServiceDeps {
  db: Kysely<Database>;
  tracker: EnrichmentTrackerRepository;
}

export interface EnrichmentGateService {
  markEnrichmentDone?(
    editionId: string,
    documentId: string,
    enrichmentType: string,
    chunkId?: string,
  ): Promise<null>;
  markEnrichmentDoneAndMaybeEnqueueCluster(
    editionId: string,
    documentId: string,
    enrichmentType: string,
    chunkId?: string,
  ): Promise<null>;
}

interface TrackedCounts {
  totalDocuments: number;
  fullyEnrichedDocuments: number;
}

async function countFullyEnrichedInTransaction(
  trx: Transaction<Database>,
  editionId: string,
): Promise<TrackedCounts> {
  const completions = await getDocumentEnrichmentCompletionsForEdition(trx, editionId);
  const totalDocuments = completions.size;

  if (totalDocuments === 0) {
    return { totalDocuments: 0, fullyEnrichedDocuments: 0 };
  }

  let fullyEnrichedDocuments = 0;
  for (const completion of completions.values()) {
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
    async markEnrichmentDone(
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

        return null;
      });
    },
    async markEnrichmentDoneAndMaybeEnqueueCluster(editionId, documentId, enrichmentType, chunkId) {
      assertValidEnrichmentType(enrichmentType);
      return deps.db.transaction().execute(async (trx) => {
        if (chunkId !== undefined && !(await documentEnrichmentHasCompletedAllChunks(
          trx, editionId, documentId, enrichmentType, chunkId,
        ))) return null;
        await markDoneInTransaction(trx, documentId, enrichmentType);
        return null;
      });
    },
  };
}
