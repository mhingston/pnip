import { Kysely, sql, type SqlBool } from "kysely";
import type { Database, JobStatus, ProcessingJob } from "../../database/kysely.js";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff.js";

export interface EnqueueInput {
  jobType: string;
  editionId?: string;
  target?: unknown;
  nextEligibleAt?: Date;
  dependsOn?: string[];
}

export interface QueueMetrics {
  byStatus: Record<JobStatus, number>;
  totalCompleted: number;
  totalFailed: number;
  totalRetries: number;
  avgProcessingLatencyMs: number | null;
  maxRetries: number;
  throughputLastHour: number;
  throughputLastDay: number;
  oldestPendingAgeMs: number | null;
}

export interface ClaimOptions {
  editionId?: string;
}

export interface ProcessingJobQueue {
  enqueue(input: EnqueueInput): Promise<ProcessingJob>;
  claim(workerId: string, opts?: ClaimOptions): Promise<ProcessingJob | null>;
  complete(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<ProcessingJob | undefined>;
  recoverStaleJobs(
    olderThanMs: number,
    opts?: { maxAttempts?: number },
  ): Promise<number>;
  cancelForEdition(input: {
    editionId: string;
    reason: string;
  }): Promise<number>;
  archiveJobs(opts: {
    statuses?: JobStatus[];
    olderThanMs?: number;
    limit?: number;
  }): Promise<number>;
  purgeArchivedJobs(opts: {
    olderThanMs?: number;
    limit?: number;
  }): Promise<number>;
  countByStatus(): Promise<Record<JobStatus, number>>;
  listFailed(opts?: {
    editionId?: string;
    jobType?: string;
    olderThanMs?: number;
    limit?: number;
  }): Promise<ProcessingJob[]>;
  requeue(jobIds: string[]): Promise<number>;
  getMetrics(): Promise<QueueMetrics>;
}

export function createProcessingJobQueue(db: Kysely<Database>): ProcessingJobQueue {
  async function countByStatus(): Promise<Record<JobStatus, number>> {
    const rows = await db
      .selectFrom("processing_jobs")
      .select("status")
      .select((eb) => eb.fn.count<number>("id").as("n"))
      .groupBy("status")
      .execute();
    const out: Record<JobStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      archived: 0,
    };
    for (const r of rows) {
      const n = Number(r.n);
      switch (r.status) {
        case "pending":
        case "running":
        case "completed":
        case "failed":
        case "archived":
          out[r.status] = n;
          break;
      }
    }
    return out;
  }

  async function getMetrics(): Promise<QueueMetrics> {
    const byStatus = await countByStatus();

    const totalsRes = await sql`SELECT
      COUNT(*) FILTER (WHERE status='completed') AS completed,
      COUNT(*) FILTER (WHERE status='failed') AS failed,
      COALESCE(SUM(retry_count), 0) AS total_retries,
      COALESCE(MAX(retry_count), 0) AS max_retries
      FROM processing_jobs`.execute(db);
    const totals = totalsRes.rows[0] as {
      completed: string | number;
      failed: string | number;
      total_retries: string | number;
      max_retries: string | number;
    };

    const latencyRes = await sql`SELECT
      AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000)::bigint AS avg_latency_ms
      FROM processing_jobs
      WHERE status='completed' AND completed_at IS NOT NULL`.execute(db);
    const latencyRow = latencyRes.rows[0] as
      | { avg_latency_ms: string | number | null }
      | undefined;

    const hourRes = await sql`SELECT COUNT(*) AS n
      FROM processing_jobs
      WHERE status='completed' AND completed_at > now() - interval '1 hour'`.execute(db);
    const hourRow = hourRes.rows[0] as { n: string | number };

    const dayRes = await sql`SELECT COUNT(*) AS n
      FROM processing_jobs
      WHERE status='completed' AND completed_at > now() - interval '1 day'`.execute(db);
    const dayRow = dayRes.rows[0] as { n: string | number };

    const ageRes = await sql`SELECT
      EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000 AS age_ms
      FROM processing_jobs
      WHERE status='pending'`.execute(db);
    const ageRow = ageRes.rows[0] as
      | { age_ms: string | number | null }
      | undefined;

    return {
      byStatus,
      totalCompleted: Number(totals.completed),
      totalFailed: Number(totals.failed),
      totalRetries: Number(totals.total_retries),
      maxRetries: Number(totals.max_retries),
      avgProcessingLatencyMs:
        latencyRow && latencyRow.avg_latency_ms !== null &&
        latencyRow.avg_latency_ms !== undefined
          ? Number(latencyRow.avg_latency_ms)
          : null,
      throughputLastHour: Number(hourRow.n),
      throughputLastDay: Number(dayRow.n),
      oldestPendingAgeMs:
        ageRow && ageRow.age_ms !== null && ageRow.age_ms !== undefined
          ? Number(ageRow.age_ms)
          : null,
    };
  }

  const queue: ProcessingJobQueue = {
    async enqueue(input: EnqueueInput): Promise<ProcessingJob> {
      const row = await db
        .insertInto("processing_jobs")
        .values({
          job_type: input.jobType,
          edition_id: input.editionId ?? null,
          target: input.target === undefined ? null : JSON.stringify(input.target),
          status: "pending",
          next_eligible_at: input.nextEligibleAt ?? sql`now()`,
          depends_on: input.dependsOn ?? [],
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row;
    },

    async claim(
      workerId: string,
      opts?: ClaimOptions,
    ): Promise<ProcessingJob | null> {
      return db.transaction().execute(async (trx) => {
        let query = trx
          .selectFrom("processing_jobs")
          .selectAll()
          .where("status", "=", "pending")
          .where(sql<SqlBool>`next_eligible_at <= now()`)
          .where(
            sql<SqlBool>`NOT EXISTS (SELECT 1 FROM unnest(depends_on) AS d(id) JOIN processing_jobs dep ON dep.id = d.id WHERE dep.status <> 'completed')`,
          );
        if (opts?.editionId) {
          query = query.where("edition_id", "=", opts.editionId);
        }
        const row = await query
          .orderBy("next_eligible_at", "asc")
          .orderBy("created_at", "asc")
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return null;
        await trx
          .updateTable("processing_jobs")
          .set({
            status: "running",
            locked_by: workerId,
            locked_at: sql`now()`,
            last_attempt_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where("id", "=", row.id)
          .execute();
        const claimed = await trx
          .selectFrom("processing_jobs")
          .selectAll()
          .where("id", "=", row.id)
          .executeTakeFirst();
        return claimed ?? null;
      });
    },

    async complete(jobId: string): Promise<void> {
      await db
        .updateTable("processing_jobs")
        .set({
          status: "completed",
          completed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", jobId)
        .where("status", "=", "running")
        .execute();
    },

    async getJob(jobId: string): Promise<ProcessingJob | undefined> {
      return db
        .selectFrom("processing_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirst();
    },

    async recoverStaleJobs(
      olderThanMs: number,
      opts?: { maxAttempts?: number },
    ): Promise<number> {
      const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const staleError = JSON.stringify({
        type: "StaleJobError",
        message: `job stuck in running for >${olderThanMs}ms`,
        recovered_at: new Date().toISOString(),
      });
      const result = await sql`UPDATE processing_jobs
        SET retry_count = retry_count + 1,
            status = CASE WHEN retry_count + 1 < ${maxAttempts} THEN 'pending' ELSE 'failed' END,
            next_eligible_at = CASE WHEN retry_count + 1 < ${maxAttempts} THEN now() ELSE next_eligible_at END,
            last_error = ${staleError}::jsonb,
            locked_by = NULL,
            locked_at = NULL,
            last_attempt_at = now(),
            updated_at = now()
        WHERE status = 'running'
          AND locked_at IS NOT NULL
          AND locked_at < now() - (${olderThanMs} * interval '1 millisecond')
        RETURNING id`.execute(db);
      return result.rows.length;
    },

    async cancelForEdition(input: {
      editionId: string;
      reason: string;
    }): Promise<number> {
      const cancelledError = JSON.stringify({
        type: "JobCancelledError",
        message: input.reason,
        stack: undefined,
      });
      const result = await sql`UPDATE processing_jobs
        SET status = 'failed',
            last_error = ${cancelledError}::jsonb,
            last_attempt_at = now(),
            updated_at = now()
        WHERE edition_id = ${input.editionId}
          AND status IN ('pending', 'running')
        RETURNING id`.execute(db);
      return result.rows.length;
    },

    async archiveJobs(opts: {
      statuses?: JobStatus[];
      olderThanMs?: number;
      limit?: number;
    }): Promise<number> {
      const statuses = opts.statuses ?? ["completed", "failed"];
      const olderThanMs = opts.olderThanMs ?? 0;
      const limit = opts.limit;
      const statusList = sql.join(statuses.map((s) => sql`${s}`));
      const ageClause =
        olderThanMs > 0
          ? sql`AND updated_at < now() - (${olderThanMs} * interval '1 millisecond')`
          : sql``;
      const limitClause =
        typeof limit === "number" && limit > 0 ? sql`LIMIT ${limit}` : sql``;
      const result = await sql`UPDATE processing_jobs
        SET status = 'archived', updated_at = now()
        WHERE id IN (
          SELECT id FROM processing_jobs
          WHERE status IN (${statusList})
            AND status <> 'archived'
            ${ageClause}
          ORDER BY updated_at
          ${limitClause}
        )
        RETURNING id`.execute(db);
      return result.rows.length;
    },

    async purgeArchivedJobs(opts: {
      olderThanMs?: number;
      limit?: number;
    }): Promise<number> {
      const olderThanMs = opts.olderThanMs ?? 0;
      const limit = opts.limit;
      const ageClause =
        olderThanMs > 0
          ? sql`AND updated_at < now() - (${olderThanMs} * interval '1 millisecond')`
          : sql``;
      const limitClause =
        typeof limit === "number" && limit > 0 ? sql`LIMIT ${limit}` : sql``;
      // PostgreSQL disallows LIMIT on a bare DELETE; use a subquery so the
      // LIMIT (and the order-by-oldest semantic) apply correctly.
      const result = await sql`DELETE FROM processing_jobs
        WHERE id IN (
          SELECT id FROM processing_jobs
          WHERE status = 'archived'
          ${ageClause}
          ORDER BY updated_at
          ${limitClause}
        )
        RETURNING id`.execute(db);
      return result.rows.length;
    },

    countByStatus,

    async listFailed(opts?: {
      editionId?: string;
      jobType?: string;
      olderThanMs?: number;
      limit?: number;
    }): Promise<ProcessingJob[]> {
      const limit = Math.min(opts?.limit ?? 1000, 10_000);
      let q = db
        .selectFrom("processing_jobs")
        .selectAll()
        .where("status", "=", "failed");
      if (opts?.editionId !== undefined) {
        q = q.where("edition_id", "=", opts.editionId);
      }
      if (opts?.jobType !== undefined) {
        q = q.where("job_type", "=", opts.jobType);
      }
      if (opts?.olderThanMs !== undefined && opts.olderThanMs > 0) {
        q = q.where(
          sql<SqlBool>`updated_at < now() - (${opts.olderThanMs} * interval '1 millisecond')`,
        );
      }
      return q.orderBy("updated_at", "desc").limit(limit).execute();
    },

    async requeue(jobIds: string[]): Promise<number> {
      if (jobIds.length === 0) return 0;
      const idList = sql.join(jobIds.map((id) => sql`${id}`));
      const result = await sql`UPDATE processing_jobs
        SET status = 'pending',
            retry_count = 0,
            next_eligible_at = now(),
            locked_by = NULL,
            locked_at = NULL,
            last_error = NULL,
            last_attempt_at = NULL,
            updated_at = now()
        WHERE id IN (${idList})
          AND status = 'failed'
        RETURNING id`.execute(db);
      return result.rows.length;
    },

    getMetrics,
  };

  return queue;
}
