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

export interface PartitionMetricEntry {
  partition_key: string;
  total_documents: number;
  distinct_days: number;
  latest_edition_date: string | null;
  latest_document_count: number;
}

export interface PartitionMetricDayEntry {
  edition_date: string;
  partition_key: string;
  document_count: number;
}

export interface PartitionMetrics {
  byPartition: PartitionMetricEntry[];
  perDayLast7Days: PartitionMetricDayEntry[];
}

function formatDateOnly(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d === "string") {
    return d.length >= 10 ? d.slice(0, 10) : d;
  }
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  return String(d).slice(0, 10);
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

/**
 * Read-only per-partition snapshot of document distribution. Groups `documents`
 * by `partition_key` joined to editions for date info. Returns the partition
 * totals, the most recent edition date that has documents in each partition,
 * the count of documents on that date, and a per-day breakdown for the last
 * seven days.
 *
 * Empty tables return `{ byPartition: [], perDayLast7Days: [] }` and never
 * throw.
 */
export async function getPartitionMetrics(
  db: Kysely<Database>,
): Promise<PartitionMetrics> {
  const summaryRes = await sql<{
    partition_key: string;
    total_documents: string | number;
    distinct_days: string | number;
    latest_edition_date: string | null;
  }>`
    SELECT
      d.partition_key AS partition_key,
      COUNT(d.id) AS total_documents,
      COUNT(DISTINCT e.publication_date) AS distinct_days,
      to_char(MAX(e.publication_date), 'YYYY-MM-DD') AS latest_edition_date
    FROM documents d
    JOIN editions e ON e.id = d.edition_id
    GROUP BY d.partition_key
    ORDER BY COUNT(d.id) DESC, d.partition_key ASC
  `.execute(db);

  const byPartition: PartitionMetricEntry[] = [];
  for (const row of summaryRes.rows) {
    const latestDate = formatDateOnly(row.latest_edition_date);
    byPartition.push({
      partition_key: row.partition_key,
      total_documents: Number(row.total_documents),
      distinct_days: Number(row.distinct_days),
      latest_edition_date: latestDate,
      latest_document_count: 0,
    });
  }

  if (byPartition.length > 0) {
    const latestRows = await sql<{
      partition_key: string;
      cnt: string | number;
    }>`
      SELECT
        d.partition_key AS partition_key,
        COUNT(d.id) AS cnt
      FROM documents d
      JOIN editions e ON e.id = d.edition_id
      WHERE (d.partition_key, e.publication_date) IN (
        SELECT d2.partition_key, MAX(e2.publication_date)
        FROM documents d2
        JOIN editions e2 ON e2.id = d2.edition_id
        GROUP BY d2.partition_key
      )
      GROUP BY d.partition_key, e.publication_date
    `.execute(db);
    const latestCountByKey = new Map<string, number>();
    for (const row of latestRows.rows) {
      latestCountByKey.set(row.partition_key, Number(row.cnt));
    }
    for (const entry of byPartition) {
      entry.latest_document_count = latestCountByKey.get(entry.partition_key) ?? 0;
    }
  }

  const dayRes = await sql<{
    publication_date: string;
    partition_key: string;
    cnt: string | number;
  }>`
    SELECT
      to_char(e.publication_date, 'YYYY-MM-DD') AS publication_date,
      d.partition_key AS partition_key,
      COUNT(d.id) AS cnt
    FROM documents d
    JOIN editions e ON e.id = d.edition_id
    WHERE e.publication_date > now() - interval '7 days'
    GROUP BY e.publication_date, d.partition_key
    ORDER BY e.publication_date DESC, d.partition_key ASC
  `.execute(db);

  const perDayLast7Days: PartitionMetricDayEntry[] = dayRes.rows.map((r) => ({
    edition_date: formatDateOnly(r.publication_date) ?? "",
    partition_key: r.partition_key,
    document_count: Number(r.cnt),
  }));

  return { byPartition, perDayLast7Days };
}
