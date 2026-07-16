import { sql, type Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";
import { createLogger, type Logger } from "../../logging/logger.js";
import {
  createProcessingJobQueue,
  type ClaimOptions,
  type ProcessingJobQueue,
} from "../queue/processing-job-queue.js";
import {
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_MAX_ATTEMPTS,
  nextEligibleDelayMs,
} from "../queue/backoff.js";
import type {
  Worker,
  WorkerContext,
  WorkerErrorPayload,
  WorkerOutcome,
} from "./worker.js";

export interface WorkerRuntime {
  runOne(workerId: string, opts?: ClaimOptions): Promise<boolean>;
}

export interface RetryConfig {
  maxAttempts?: number;
  schedule?: readonly number[];
  jitter?: boolean;
  rng?: () => number;
}

interface ResolvedRetryConfig {
  maxAttempts: number;
  schedule: readonly number[];
  jitter: boolean;
  rng: () => number;
}

const TRANSIENT_FAILURE_RE =
  /\b429\b|rate limit|too many requests|fetch failed|\b5\d\d\b|econnreset|etimedout|timed out|temporarily unavailable/i;

export interface CreateWorkerRuntimeDeps {
  db: Kysely<Database>;
  queue: ProcessingJobQueue;
  workers: Worker[];
  logger?: Logger;
  retry?: RetryConfig;
}

export function serializeError(err: unknown): WorkerErrorPayload {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { type: "Error", message: String(err) };
}

/**
 * Resolve the stable identity written to worker execution logs.
 *
 * Most existing factories return object-literal Workers and therefore do not
 * have a useful constructor name. The job type is the runtime registration
 * key, so it is a stable fallback until a factory supplies an explicit name.
 */
export function resolveWorkerIdentity(worker: Worker, jobType: string): string {
  const name = worker.name?.trim();
  return name || jobType;
}

export function createWorkerRuntime(
  deps: CreateWorkerRuntimeDeps,
): WorkerRuntime {
  const { db, queue, workers } = deps;
  const logger = deps.logger ?? createLogger();
  const retry: ResolvedRetryConfig = {
    maxAttempts: deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    schedule: deps.retry?.schedule ?? DEFAULT_BACKOFF_SCHEDULE_MS,
    jitter: deps.retry?.jitter ?? true,
    rng: deps.retry?.rng ?? Math.random,
  };

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

  async function scheduleRetryOrFail(
    job: { id: string; retry_count: number },
    payload: WorkerErrorPayload,
    log: Logger,
  ): Promise<void> {
    const newRetryCount = job.retry_count + 1;
    if (newRetryCount < retry.maxAttempts) {
      const delayMs = nextEligibleDelayMs(newRetryCount, {
        schedule: retry.schedule,
        jitter: retry.jitter,
        rng: retry.rng,
      });
      await db
        .updateTable("processing_jobs")
        .set({
          status: "pending",
          retry_count: newRetryCount,
          next_eligible_at: sql`now() + (${delayMs} * interval '1 millisecond')`,
          last_error: JSON.stringify(payload),
          last_attempt_at: sql`now()`,
          locked_by: null,
          locked_at: null,
          updated_at: sql`now()`,
        })
        .where("id", "=", job.id)
        .execute();
      log.info("worker execute failed, retry scheduled", {
        retryCount: newRetryCount,
        nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
      });
    } else {
      await db
        .updateTable("processing_jobs")
        .set({
          status: "failed",
          retry_count: newRetryCount,
          last_error: JSON.stringify(payload),
          last_attempt_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", job.id)
        .execute();
      log.error("worker execute failed, permanent failure", {
        retryCount: newRetryCount,
      });
    }
  }

  async function deferTransientFailure(
    job: { id: string; retry_count: number },
    payload: WorkerErrorPayload,
    log: Logger,
  ): Promise<void> {
    const delayMs = nextEligibleDelayMs(job.retry_count, {
      schedule: retry.schedule,
      jitter: retry.jitter,
      rng: retry.rng,
    });
    await db
      .updateTable("processing_jobs")
      .set({
        status: "pending",
        next_eligible_at: sql`now() + (${delayMs} * interval '1 millisecond')`,
        last_error: JSON.stringify(payload),
        locked_by: null,
        locked_at: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", job.id)
      .where("status", "=", "running")
      .execute();
    log.warn("transient worker failure deferred without consuming a retry", {
      delayMs,
    });
  }

  return {
    async runOne(
      workerId: string,
      opts?: ClaimOptions,
    ): Promise<boolean> {
      const job = await queue.claim(workerId, opts);
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

      const log = jobLog.child({
        worker: resolveWorkerIdentity(worker, job.job_type),
      });
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
        if (TRANSIENT_FAILURE_RE.test(payload.message)) {
          await deferTransientFailure(job, payload, log);
        } else {
          await scheduleRetryOrFail(job, payload, log);
        }
        return true;
      }
      const durationMs = Date.now() - start;

      if (outcome.deferUntil !== undefined) {
        await db
          .updateTable("processing_jobs")
          .set({
            status: "pending",
            next_eligible_at: outcome.deferUntil,
            locked_by: null,
            locked_at: null,
            updated_at: sql`now()`,
          })
          .where("id", "=", job.id)
          .where("status", "=", "running")
          .execute();
        log.info("worker execution deferred", {
          durationMs,
          nextEligibleAt: outcome.deferUntil.toISOString(),
        });
        return true;
      }

      await db.transaction().execute(async (trx) => {
        const txQueue = createProcessingJobQueue(trx);
        for (const c of outcome.childJobs ?? []) {
          await txQueue.enqueue({
            jobType: c.jobType,
            editionId: c.editionId,
            target: c.target,
            nextEligibleAt: c.nextEligibleAt,
            dependsOn: c.dependsOn,
          });
        }
        await txQueue.complete(job.id);
      });

      log.info("worker execute completed", { durationMs });
      return true;
    },
  };
}
