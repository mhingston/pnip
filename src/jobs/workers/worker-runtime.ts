import { sql, type Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";
import { createLogger, type Logger } from "../../logging/logger.js";
import {
  createProcessingJobQueue,
  type ProcessingJobQueue,
} from "../queue/processing-job-queue.js";
import type {
  Worker,
  WorkerContext,
  WorkerErrorPayload,
  WorkerOutcome,
} from "./worker.js";

export interface WorkerRuntime {
  runOne(workerId: string): Promise<boolean>;
}

export interface CreateWorkerRuntimeDeps {
  db: Kysely<Database>;
  queue: ProcessingJobQueue;
  workers: Worker[];
  logger?: Logger;
}

export function serializeError(err: unknown): WorkerErrorPayload {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { type: "Error", message: String(err) };
}

export function createWorkerRuntime(
  deps: CreateWorkerRuntimeDeps,
): WorkerRuntime {
  const { db, queue, workers } = deps;
  const logger = deps.logger ?? createLogger();

  async function markFailed(
    job: { id: string; retry_count: number },
    payload: WorkerErrorPayload,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("processing_jobs")
        .set({
          status: "failed",
          last_error: JSON.stringify(payload),
          retry_count: job.retry_count + 1,
          last_attempt_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", job.id)
        .execute();
    });
  }

  return {
    async runOne(workerId: string): Promise<boolean> {
      const job = await queue.claim(workerId);
      if (!job) return false;

      const jobLog = logger.child({
        jobId: job.id,
        editionId: job.edition_id ?? undefined,
        stage: job.job_type,
      });

      const worker = workers.find((w) => w.supports(job.job_type));
      if (!worker) {
        jobLog.warn(`no worker registered for job type '${job.job_type}'`);
        await markFailed(job, {
          type: "NoWorkerError",
          message: `no worker registered for job type '${job.job_type}'`,
        });
        return true;
      }

      const log = jobLog.child({ worker: worker.constructor.name });
      const ctx: WorkerContext = { db, logger: log };
      const start = Date.now();
      let outcome: WorkerOutcome;
      try {
        outcome = await worker.execute(job, ctx);
      } catch (err) {
        const durationMs = Date.now() - start;
        const payload = serializeError(err);
        log.error("worker execute failed", {
          durationMs,
          error: {
            name: payload.type,
            message: payload.message,
            stack: payload.stack,
          },
        });
        await markFailed(job, payload);
        return true;
      }
      const durationMs = Date.now() - start;

      await db.transaction().execute(async (trx) => {
        const txQueue = createProcessingJobQueue(trx);
        for (const c of outcome.childJobs ?? []) {
          await txQueue.enqueue(c);
        }
        await txQueue.complete(job.id);
      });

      log.info("worker execute completed", { durationMs });
      return true;
    },
  };
}
