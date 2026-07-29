import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../database/kysely.js";
import {
  getDocumentEnrichmentCompletionsForEdition,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";

const CLUSTER_STORIES_JOB_TYPE = "cluster_stories";
const MUTABLE_EDITION_STATUSES = ["building", "failed"] as const;
const LEGACY_TEXT_ENRICHMENT_JOB_TYPES = [
  "summarize_chunk",
  "extract_entities",
  "assign_topics",
  "classify_quality",
] as const;
const SUPERSEDED_ENRICHMENT_JOB_TYPES = [
  ...LEGACY_TEXT_ENRICHMENT_JOB_TYPES,
  "embed_chunk",
] as const;

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

/**
 * Upgrade queued work created before text enrichment was consolidated.  Old
 * workers no longer exist, so leaving these jobs pending would turn them into
 * NoWorker failures and strand otherwise mutable editions.  Each affected
 * document gets one replacement enrich_chunk job; legacy work is retained as
 * failed history rather than deleted.
 */
export async function reconcileLegacyEnrichmentJobs(
  db: Kysely<Database>,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    // This reconciliation is normally run at every drain start. A
    // transaction-scoped advisory lock makes the select/replace sequence
    // exactly once even when two drain commands overlap.
    await sql`SELECT pg_advisory_xact_lock(hashtext('pnip:legacy-enrichment-reconciliation'))`.execute(trx);
    const candidates = await sql<{
      edition_id: string;
      document_id: string;
      chunk_id: string;
    }>`
      SELECT DISTINCT pj.edition_id, pj.target->>'documentId' AS document_id,
        pj.target->>'chunkId' AS chunk_id
      FROM processing_jobs pj
      INNER JOIN editions e ON e.id = pj.edition_id
      WHERE e.status IN (${sql.join(MUTABLE_EDITION_STATUSES.map((status) => sql`${status}`), sql`, `)})
        AND pj.job_type IN (${sql.join(LEGACY_TEXT_ENRICHMENT_JOB_TYPES.map((type) => sql`${type}`), sql`, `)})
        AND pj.target ? 'documentId'
        AND pj.target ? 'chunkId'
        AND pj.status IN ('pending', 'running', 'completed', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs replacement
          WHERE replacement.edition_id = pj.edition_id
            AND replacement.job_type = 'enrich_chunk'
            AND replacement.target->>'chunkId' = pj.target->>'chunkId'
            AND replacement.status IN ('pending', 'running', 'completed', 'archived')
        )
    `.execute(trx);

    if (candidates.rows.length === 0) return 0;

    const replacementError = JSON.stringify({
      type: "LegacyEnrichmentSuperseded",
      message: "Superseded by combined enrich_chunk job during deployment reconciliation.",
    });
    for (const candidate of candidates.rows) {
      // Supersede only this exact chunk. A partially migrated long document
      // may already have a valid enrich/embed pair for its other chunks.
      await sql`
        UPDATE processing_jobs pj
        SET status = 'failed', last_error = ${replacementError}::jsonb,
            locked_by = NULL, locked_at = NULL, updated_at = now()
        FROM editions e
        WHERE e.id = pj.edition_id
          AND e.status IN (${sql.join(MUTABLE_EDITION_STATUSES.map((status) => sql`${status}`), sql`, `)})
          AND pj.edition_id = ${candidate.edition_id}
          AND pj.target->>'documentId' = ${candidate.document_id}
          AND pj.target->>'chunkId' = ${candidate.chunk_id}
          AND pj.job_type IN (${sql.join(SUPERSEDED_ENRICHMENT_JOB_TYPES.map((type) => sql`${type}`), sql`, `)})
          AND pj.status IN ('pending', 'running', 'completed')
      `.execute(trx);

      await trx.insertInto("processing_jobs").values({
        job_type: "enrich_chunk",
        edition_id: candidate.edition_id,
        target: JSON.stringify({ documentId: candidate.document_id, chunkId: candidate.chunk_id }),
        status: "pending",
        next_eligible_at: sql<Date>`now()`,
        depends_on: [],
      }).execute();
    }
    return candidates.rows.length;
  });
}
