import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../database/kysely.js";

export interface RetentionOptions {
  olderThanMs: number;
  limit?: number;
}

export interface RetentionCounts {
  editions: number;
  jobs: number;
  lineage: number;
}

const DEFAULT_LIMIT = 10_000;

function cutoffFor(options: RetentionOptions): Date {
  if (!Number.isFinite(options.olderThanMs) || options.olderThanMs <= 0) {
    throw new Error("retention window must be a positive duration");
  }
  return new Date(Date.now() - options.olderThanMs);
}

function limitFor(options: RetentionOptions): number {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("retention limit must be a positive integer");
  }
  return limit;
}

/**
 * CTEs shared by preview and purge. The edition set is deliberately bounded
 * so a maintenance run cannot delete an unbounded amount of history; the
 * next run continues from the oldest remaining edition.
 */
function expiredDataCtes(cutoff: Date, limit: number) {
  return sql`
    WITH expired_editions AS (
      SELECT id
      FROM editions
      WHERE created_at < ${cutoff}
      ORDER BY created_at ASC
      LIMIT ${limit}
    ),
    expired_discovery_events AS (
      SELECT id FROM discovery_events
      WHERE edition_id IN (SELECT id FROM expired_editions)
    ),
    expired_documents AS (
      SELECT id FROM documents
      WHERE edition_id IN (SELECT id FROM expired_editions)
    ),
    expired_sections AS (
      SELECT id FROM document_sections
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_chunks AS (
      SELECT id FROM document_chunks
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_summaries AS (
      SELECT id FROM summaries
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_entities AS (
      SELECT id FROM entities
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_topics AS (
      SELECT id FROM topics
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_quality AS (
      SELECT id FROM quality_classifications
      WHERE document_id IN (SELECT id FROM expired_documents)
    ),
    expired_embeddings AS (
      SELECT id FROM embeddings
      WHERE chunk_id IN (SELECT id FROM expired_chunks)
    ),
    expired_stories AS (
      SELECT id FROM story_clusters
      WHERE edition_id IN (SELECT id FROM expired_editions)
    ),
    expired_story_summaries AS (
      SELECT id FROM story_summaries
      WHERE story_id IN (SELECT id FROM expired_stories)
    ),
    expired_lineage_ids(source_type, id) AS (
      SELECT 'discovery_event', id::text FROM expired_discovery_events
      UNION ALL SELECT 'document', id::text FROM expired_documents
      UNION ALL SELECT 'section', id::text FROM expired_sections
      UNION ALL SELECT 'chunk', id::uuid::text FROM expired_chunks
      UNION ALL SELECT 'summary', id::text FROM expired_summaries
      UNION ALL SELECT 'entity', id::text FROM expired_entities
      UNION ALL SELECT 'topic', id::text FROM expired_topics
      UNION ALL SELECT 'quality_classification', id::text FROM expired_quality
      UNION ALL SELECT 'embedding', id::text FROM expired_embeddings
      UNION ALL SELECT 'story', id::text FROM expired_stories
      UNION ALL SELECT 'story_summary', id::text FROM expired_story_summaries
    )
  `;
}

function lineageExpiryPredicate() {
  return sql`
    EXISTS (
      SELECT 1 FROM expired_lineage_ids e
      WHERE e.source_type = document_lineage.source_type
        AND e.id = document_lineage.source_id::text
    )
    OR EXISTS (
      SELECT 1 FROM expired_lineage_ids e
      WHERE e.source_type = document_lineage.target_type
        AND e.id = document_lineage.target_id::text
    )
  `;
}

export async function previewRetention(
  db: Kysely<Database>,
  options: RetentionOptions,
): Promise<RetentionCounts> {
  const cutoff = cutoffFor(options);
  const limit = limitFor(options);
  const ctes = expiredDataCtes(cutoff, limit);
  const predicate = lineageExpiryPredicate();
  const result = await sql<{
    editions: string | number;
    jobs: string | number;
    lineage: string | number;
  }>`
    ${ctes},
    expired_job_ids AS (
      SELECT id FROM processing_jobs
      WHERE updated_at < ${cutoff}
         OR edition_id IN (SELECT id FROM expired_editions)
      ORDER BY updated_at ASC
      LIMIT ${limit}
    )
    SELECT
      (SELECT COUNT(*) FROM expired_editions) AS editions,
      (SELECT COUNT(*) FROM expired_job_ids) AS jobs,
      (SELECT COUNT(*) FROM document_lineage WHERE ${predicate}) AS lineage
  `.execute(db);
  const row = result.rows[0];
  return {
    editions: Number(row?.editions ?? 0),
    jobs: Number(row?.jobs ?? 0),
    lineage: Number(row?.lineage ?? 0),
  };
}

export async function purgeExpiredData(
  db: Kysely<Database>,
  options: RetentionOptions,
): Promise<RetentionCounts> {
  const cutoff = cutoffFor(options);
  const limit = limitFor(options);

  return db.transaction().execute(async (trx: Transaction<Database>) => {
    const ctes = expiredDataCtes(cutoff, limit);
    const lineagePredicate = lineageExpiryPredicate();

    const jobs = await sql`
      ${ctes},
      expired_job_ids AS (
        SELECT id FROM processing_jobs
        WHERE updated_at < ${cutoff}
           OR edition_id IN (SELECT id FROM expired_editions)
        ORDER BY updated_at ASC
        LIMIT ${limit}
      )
      DELETE FROM processing_jobs
      WHERE id IN (SELECT id FROM expired_job_ids)
      RETURNING id
    `.execute(trx);

    const lineage = await sql`
      ${ctes}
      DELETE FROM document_lineage
      WHERE ${lineagePredicate}
      RETURNING id
    `.execute(trx);

    const editions = await sql`
      ${ctes}
      DELETE FROM editions
      WHERE id IN (SELECT id FROM expired_editions)
      RETURNING id
    `.execute(trx);

    return {
      editions: editions.rows.length,
      jobs: jobs.rows.length,
      lineage: lineage.rows.length,
    };
  });
}
