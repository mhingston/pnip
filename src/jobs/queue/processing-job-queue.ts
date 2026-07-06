import { Kysely, sql, type SqlBool } from "kysely";
import type { Database, ProcessingJob } from "../../database/kysely.js";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff.js";

export interface EnqueueInput {
  jobType: string;
  editionId?: string;
  target?: unknown;
  nextEligibleAt?: Date;
}

export interface ProcessingJobQueue {
  enqueue(input: EnqueueInput): Promise<ProcessingJob>;
  claim(workerId: string): Promise<ProcessingJob | null>;
  complete(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<ProcessingJob | undefined>;
  recoverStaleJobs(
    olderThanMs: number,
    opts?: { maxAttempts?: number },
  ): Promise<number>;
}

export function createProcessingJobQueue(db: Kysely<Database>): ProcessingJobQueue {
  return {
    async enqueue(input: EnqueueInput): Promise<ProcessingJob> {
      const row = await db
        .insertInto("processing_jobs")
        .values({
          job_type: input.jobType,
          edition_id: input.editionId ?? null,
          target: input.target === undefined ? null : JSON.stringify(input.target),
          status: "pending",
          next_eligible_at: input.nextEligibleAt ?? sql`now()`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row;
    },

    async claim(workerId: string): Promise<ProcessingJob | null> {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("processing_jobs")
          .selectAll()
          .where("status", "=", "pending")
          .where(sql<SqlBool>`next_eligible_at <= now()`)
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
  };
}
