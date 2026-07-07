import { Kysely, sql } from "kysely";
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
      const row = await db
        .selectFrom("document_enrichment_status")
        .select((eb) => eb.fn.count<number>("document_id").as("done_count"))
        .where("document_id", "=", documentId)
        .where("status", "=", "done")
        .executeTakeFirstOrThrow();
      return Number(row.done_count) === REQUIRED_ENRICHMENT_TYPES.length;
    },

    async getDocumentCounts(editionId) {
      const totalRow = await db
        .selectFrom("documents")
        .select((eb) => eb.fn.count<number>("id").as("total"))
        .where("edition_id", "=", editionId)
        .executeTakeFirstOrThrow();
      const totalDocuments = Number(totalRow.total);

      const completedTypeRowsRow = await db
        .selectFrom("documents as d")
        .innerJoin("document_enrichment_status as s", "s.document_id", "d.id")
        .select((eb) => eb.fn.count<number>("s.document_id").as("completed"))
        .where("d.edition_id", "=", editionId)
        .where("s.status", "=", "done")
        .executeTakeFirstOrThrow();

      const completedByDoc = new Map<string, number>();
      const perDocRows = await db
        .selectFrom("document_enrichment_status as s")
        .innerJoin("documents as d", "d.id", "s.document_id")
        .select(["s.document_id", (eb) => eb.fn.count<number>("s.enrichment_type").as("c")])
        .where("d.edition_id", "=", editionId)
        .where("s.status", "=", "done")
        .groupBy("s.document_id")
        .execute();
      for (const r of perDocRows) {
        completedByDoc.set(r.document_id, Number(r.c));
      }

      let fullyEnrichedDocuments = 0;
      for (const [, c] of completedByDoc) {
        if (c === REQUIRED_ENRICHMENT_TYPES.length) fullyEnrichedDocuments += 1;
      }

      return {
        totalDocuments,
        fullyEnrichedDocuments,
        totalCompletedTypeRows: Number(completedTypeRowsRow.completed),
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
