import { Kysely, sql, Transaction } from "kysely";
import type { Database } from "../database/kysely.js";

export const REQUIRED_ENRICHMENT_TYPES = [
  "summarize_chunk",
  "extract_entities",
  "assign_topics",
  "embed_chunk",
  "classify_quality",
] as const;

export type EnrichmentType = (typeof REQUIRED_ENRICHMENT_TYPES)[number];

export type EnrichmentStatus = "pending" | "done";

export interface DocumentEnrichmentStatusRow {
  document_id: string;
  enrichment_type: string;
  status: EnrichmentStatus;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EditionEnrichmentCounts {
  totalDocuments: number;
  fullyEnrichedDocuments: number;
  totalCompletedTypeRows: number;
  expectedTypeRows: number;
}

export interface DocumentEnrichmentCompletion {
  completedTypes: string[];
}

export class InvalidEnrichmentTypeError extends Error {
  readonly enrichmentType: string;
  constructor(enrichmentType: string) {
    super(
      `invalid enrichment type '${enrichmentType}'; expected one of ${REQUIRED_ENRICHMENT_TYPES.join(", ")}`,
    );
    this.name = "InvalidEnrichmentTypeError";
    this.enrichmentType = enrichmentType;
  }
}

export interface EnrichmentTrackerRepository {
  markDone(documentId: string, enrichmentType: string): Promise<DocumentEnrichmentStatusRow>;
  resetForDocument(documentId: string): Promise<void>;
  getCompletedTypesForDocument(documentId: string): Promise<string[]>;
  isDocumentFullyEnriched(documentId: string): Promise<boolean>;
  getDocumentCounts(editionId: string): Promise<EditionEnrichmentCounts>;
  isEditionFullyEnriched(editionId: string): Promise<boolean>;
  getEditionEnqueuedAt(editionId: string): Promise<Date | null>;
  claimEditionEnqueue(editionId: string): Promise<Date | null>;
  resetEditionEnqueue(editionId: string): Promise<void>;
}

function assertValidEnrichmentType(enrichmentType: string): asserts enrichmentType is EnrichmentType {
  if (!(REQUIRED_ENRICHMENT_TYPES as readonly string[]).includes(enrichmentType)) {
    throw new InvalidEnrichmentTypeError(enrichmentType);
  }
}

export { assertValidEnrichmentType };

/**
 * Read the effective completion state for a document.
 *
 * The tracker table is intentionally a compact document-level summary, but
 * the source of truth for chunked documents is the per-chunk job history. A
 * document can otherwise look complete if an older worker marked a type done
 * after only its first chunk. Documents without enrichment jobs retain the
 * tracker-only behavior used by small fixtures and legacy imports.
 */
export async function getDocumentEnrichmentCompletion(
  db: Kysely<Database> | Transaction<Database>,
  documentId: string,
): Promise<DocumentEnrichmentCompletion> {
  const rows = await sql<{
    enrichment_type: string;
    chunk_count: number | string;
    observed_job_chunks: number | string;
    completed_job_chunks: number | string;
    done_status_rows: number | string;
  }>`
    WITH required_types(enrichment_type) AS (
      VALUES ${sql.join(
        REQUIRED_ENRICHMENT_TYPES.map((type) => sql`(${type})`),
        sql`, `,
      )}
    ),
    chunk_counts AS (
      SELECT COUNT(*)::int AS chunk_count
      FROM document_chunks
      WHERE document_id = ${documentId}
    ),
    job_counts AS (
      SELECT
        job_type AS enrichment_type,
        COUNT(DISTINCT target->>'chunkId')::int AS observed_job_chunks,
        COUNT(DISTINCT target->>'chunkId') FILTER (
          WHERE status IN ('completed', 'archived')
        )::int AS completed_job_chunks
      FROM processing_jobs
      WHERE target->>'documentId' = ${documentId}
        AND target ? 'chunkId'
      GROUP BY job_type
    ),
    status_counts AS (
      SELECT
        enrichment_type,
        COUNT(*) FILTER (WHERE status = 'done')::int AS done_status_rows
      FROM document_enrichment_status
      WHERE document_id = ${documentId}
      GROUP BY enrichment_type
    )
    SELECT
      r.enrichment_type,
      c.chunk_count,
      COALESCE(j.observed_job_chunks, 0)::int AS observed_job_chunks,
      COALESCE(j.completed_job_chunks, 0)::int AS completed_job_chunks,
      COALESCE(s.done_status_rows, 0)::int AS done_status_rows
    FROM required_types r
    CROSS JOIN chunk_counts c
    LEFT JOIN job_counts j ON j.enrichment_type = r.enrichment_type
    LEFT JOIN status_counts s ON s.enrichment_type = r.enrichment_type
  `.execute(db);

  const completedTypes = rows.rows
    .filter((row) => {
      const chunkCount = Number(row.chunk_count);
      const observedJobChunks = Number(row.observed_job_chunks);
      const completedJobChunks = Number(row.completed_job_chunks);
      if (observedJobChunks > 0) {
        return completedJobChunks >= chunkCount && chunkCount > 0;
      }
      return Number(row.done_status_rows) > 0;
    })
    .map((row) => row.enrichment_type);

  return { completedTypes };
}

export function createEnrichmentTrackerRepository(
  db: Kysely<Database>,
): EnrichmentTrackerRepository {
  return {
    async markDone(documentId, enrichmentType) {
      assertValidEnrichmentType(enrichmentType);
      return db
        .insertInto("document_enrichment_status")
        .values({
          document_id: documentId,
          enrichment_type: enrichmentType,
          status: "done" as const,
          completed_at: sql<Date>`now()`,
        })
        .onConflict((oc) =>
          oc.columns(["document_id", "enrichment_type"]).doUpdateSet({
            status: "done" as const,
            completed_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow() as Promise<DocumentEnrichmentStatusRow>;
    },

    async resetForDocument(documentId) {
      await db
        .deleteFrom("document_enrichment_status")
        .where("document_id", "=", documentId)
        .execute();
    },

    async getCompletedTypesForDocument(documentId) {
      const rows = await db
        .selectFrom("document_enrichment_status")
        .select(["enrichment_type"])
        .where("document_id", "=", documentId)
        .where("status", "=", "done")
        .execute();
      return rows.map((r) => r.enrichment_type);
    },

    async isDocumentFullyEnriched(documentId) {
      const completion = await getDocumentEnrichmentCompletion(db, documentId);
      return completion.completedTypes.length === REQUIRED_ENRICHMENT_TYPES.length;
    },

    async getDocumentCounts(editionId) {
      const totalRow = await db
        .selectFrom("documents")
        .select((eb) => eb.fn.count<number>("id").as("total"))
        .where("edition_id", "=", editionId)
        .executeTakeFirstOrThrow();
      const totalDocuments = Number(totalRow.total);

      const documents = await db
        .selectFrom("documents")
        .select("id")
        .where("edition_id", "=", editionId)
        .execute();

      let fullyEnrichedDocuments = 0;
      let totalCompletedTypeRows = 0;
      for (const document of documents) {
        const completion = await getDocumentEnrichmentCompletion(db, document.id);
        totalCompletedTypeRows += completion.completedTypes.length;
        if (completion.completedTypes.length === REQUIRED_ENRICHMENT_TYPES.length) {
          fullyEnrichedDocuments += 1;
        }
      }

      return {
        totalDocuments,
        fullyEnrichedDocuments,
        totalCompletedTypeRows,
        expectedTypeRows: totalDocuments * REQUIRED_ENRICHMENT_TYPES.length,
      };
    },

    async isEditionFullyEnriched(editionId) {
      const counts = await this.getDocumentCounts(editionId);
      if (counts.totalDocuments === 0) return false;
      return counts.fullyEnrichedDocuments === counts.totalDocuments;
    },

    async getEditionEnqueuedAt(editionId) {
      const row = await db
        .selectFrom("editions")
        .select(["cluster_stories_enqueued_at"])
        .where("id", "=", editionId)
        .executeTakeFirst();
      return row?.cluster_stories_enqueued_at ?? null;
    },

    async claimEditionEnqueue(editionId) {
      const updated = await db
        .updateTable("editions")
        .set({ cluster_stories_enqueued_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
        .where("id", "=", editionId)
        .where("cluster_stories_enqueued_at", "is", null)
        .returning(["cluster_stories_enqueued_at"])
        .executeTakeFirst();
      return updated?.cluster_stories_enqueued_at ?? null;
    },

    async resetEditionEnqueue(editionId) {
      await db
        .updateTable("editions")
        .set({ cluster_stories_enqueued_at: null, updated_at: sql<Date>`now()` })
        .where("id", "=", editionId)
        .execute();
    },
  };
}
