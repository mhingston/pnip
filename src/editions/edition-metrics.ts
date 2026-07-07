import { Kysely, sql } from "kysely";
import type { Database } from "../database/kysely.js";

export interface EditionMetrics {
  total: number;
  byStatus: Record<string, number>;
  publishedCount: number;
  avgPublicationDurationMs: number | null;
  lastPublishedAt: Date | null;
  oldestBuildingAgeMs: number | null;
}

/**
 * Read-only snapshot of edition health (§58). Safe to call on an empty table:
 * count fields return 0, and avg/duration/age fields return null.
 */
export async function getEditionMetrics(
  db: Kysely<Database>,
): Promise<EditionMetrics> {
  const byStatusRes = await sql`SELECT status, COUNT(*) AS n
    FROM editions
    GROUP BY status`.execute(db);
  const byStatus: Record<string, number> = {};
  for (const r of byStatusRes.rows as { status: string; n: string | number }[]) {
    byStatus[r.status] = Number(r.n);
  }

  const totalsRes = await sql`SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status='published') AS published,
    MAX(published_at) AS last_published
    FROM editions`.execute(db);
  const totals = totalsRes.rows[0] as {
    total: string | number;
    published: string | number;
    last_published: Date | null;
  };

  const avgRes = await sql`SELECT
    AVG(EXTRACT(EPOCH FROM (published_at - created_at)) * 1000)::bigint AS avg_dur
    FROM editions
    WHERE status='published' AND published_at IS NOT NULL`.execute(db);
  const avgRow = avgRes.rows[0] as
    | { avg_dur: string | number | null }
    | undefined;

  const ageRes = await sql`SELECT
    EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000 AS age_ms
    FROM editions
    WHERE status='building'`.execute(db);
  const ageRow = ageRes.rows[0] as
    | { age_ms: string | number | null }
    | undefined;

  return {
    total: Number(totals.total),
    byStatus,
    publishedCount: Number(totals.published),
    avgPublicationDurationMs:
      avgRow && avgRow.avg_dur !== null && avgRow.avg_dur !== undefined
        ? Number(avgRow.avg_dur)
        : null,
    lastPublishedAt: totals.last_published ?? null,
    oldestBuildingAgeMs:
      ageRow && ageRow.age_ms !== null && ageRow.age_ms !== undefined
        ? Number(ageRow.age_ms)
        : null,
  };
}
