import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../database/kysely.js";
import {
  getDocumentEnrichmentCompletionsForEdition,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";

const CLUSTER_STORIES_JOB_TYPE = "cluster_stories";
const MUTABLE_EDITION_STATUSES = ["building", "failed"] as const;

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

async function hasUnclusteredDocument(
  db: DatabaseExecutor,
  editionId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("documents as d")
    .leftJoin("cluster_members as cm", "cm.document_id", "d.id")
    .select("d.id")
    .where("d.edition_id", "=", editionId)
    .where("cm.id", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

async function isEditionFullyEnriched(
  db: DatabaseExecutor,
  editionId: string,
): Promise<boolean> {
  const completions = await getDocumentEnrichmentCompletionsForEdition(
    db,
    editionId,
  );
  if (completions.size === 0) return false;

  for (const completion of completions.values()) {
    if (completion.completedTypes.length !== REQUIRED_ENRICHMENT_TYPES.length) {
      return false;
    }
  }
  return true;
}

async function reconcileEdition(
  db: Kysely<Database>,
  editionId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    // Lock the edition row so concurrent process drains cannot both enqueue a
    // replacement cluster job after observing the same completed snapshot.
    const edition = await trx
      .selectFrom("editions")
      .select(["id", "status"])
      .where("id", "=", editionId)
      .where("status", "in", [...MUTABLE_EDITION_STATUSES])
      .forUpdate()
      .executeTakeFirst();
    if (!edition) return false;

    const activeClusterJob = await trx
      .selectFrom("processing_jobs")
      .select("id")
      .where("edition_id", "=", editionId)
      .where("job_type", "=", CLUSTER_STORIES_JOB_TYPE)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    if (activeClusterJob) return false;

    if (!(await hasUnclusteredDocument(trx, editionId))) return false;
    if (!(await isEditionFullyEnriched(trx, editionId))) return false;

    await trx
      .updateTable("editions")
      .set({
        cluster_stories_enqueued_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", editionId)
      .execute();

    await trx
      .insertInto("processing_jobs")
      .values({
        job_type: CLUSTER_STORIES_JOB_TYPE,
        edition_id: editionId,
        target: JSON.stringify({ editionId }),
        status: "pending",
        next_eligible_at: sql<Date>`now()`,
        depends_on: [],
      })
      .execute();

    return true;
  });
}

/**
 * Repair the late-discovery race where all enrichment completed after the
 * original cluster job had already run. Only mutable editions are considered;
 * published editions remain immutable and require an explicit reissue.
 */
export async function reconcileMissingClusterJobs(
  db: Kysely<Database>,
): Promise<number> {
  const candidates = await db
    .selectFrom("editions as e")
    .innerJoin("documents as d", "d.edition_id", "e.id")
    .leftJoin("cluster_members as cm", "cm.document_id", "d.id")
    .select("e.id")
    .where("e.status", "in", [...MUTABLE_EDITION_STATUSES])
    .where("cm.id", "is", null)
    .distinct()
    .execute();

  let requeued = 0;
  for (const candidate of candidates) {
    if (await reconcileEdition(db, candidate.id)) requeued++;
  }
  return requeued;
}
