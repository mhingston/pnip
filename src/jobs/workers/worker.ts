import type { Kysely } from "kysely";
import type { Database, ProcessingJob } from "../../database/kysely.js";
import type { Logger } from "../../logging/logger.js";

export interface EnqueueJobInput {
  jobType: string;
  editionId?: string;
  target?: unknown;
  nextEligibleAt?: Date;
}

export interface WorkerContext {
  db: Kysely<Database>;
  logger: Logger;
}

export interface WorkerOutcome {
  childJobs?: EnqueueJobInput[];
}

export interface Worker {
  supports(jobType: string): boolean;
  execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome>;
}

export interface WorkerErrorPayload {
  type: string;
  message: string;
  stack?: string;
}
