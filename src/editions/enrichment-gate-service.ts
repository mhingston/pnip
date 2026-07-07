import { Kysely, Transaction, sql } from "kysely";
import type { Database } from "../database/kysely.js";
import type { EnqueueJobInput } from "../jobs/workers/worker.js";
import {
  type EnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
  assertValidEnrichmentType,
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
  const totalRow = await trx
    .selectFrom("documents")
    .select((eb) => eb.fn.count<number>("id").as("total"))
    .where("edition_id", "=", editionId)
    .executeTakeFirstOrThrow();
  const totalDocuments = Number(totalRow.total);

  if (totalDocuments === 0) {
    return { totalDocuments: 0, fullyEnrichedDocuments: 0 };
  }

  const perDoc = await trx
    .selectFrom("document_enrichment_status as s")
    .innerJoin("documents as d", "d.id", "s.document_id")
    .select(["s.document_id", (eb) => eb.fn.count<number>("s.enrichment_type").as("c")])
    .where("d.edition_id", "=", editionId)
    .where("s.status", "=", "done")
    .groupBy("s.document_id")
    .execute();

  let fullyEnrichedDocuments = 0;
  for (const r of perDoc) {
    if (Number(r.c) === REQUIRED_ENRICHMENT_TYPES.length) fullyEnrichedDocuments += 1;
  }

  return { totalDocuments, fullyEnrichedDocuments };
}

async function claimEditionForClusterInTransaction(
  trx: Transaction<Database>,
  editionId: string,
): Promise<Date | null> {
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
    async markEnrichmentDoneAndMaybeEnqueueCluster(editionId, documentId, enrichmentType) {
      assertValidEnrichmentType(enrichmentType);

      return deps.db.transaction().execute(async (trx) => {
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
