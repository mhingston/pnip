import { Kysely, PostgresDialect, type Generated } from "kysely";
import type { PgPool } from "./pool.js";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "archived";

export type EditionStatus = "building" | "ready" | "publishing" | "published" | "failed";

export interface Edition {
  id: string;
  publication_date: Date;
  status: EditionStatus;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  metadata: unknown | null;
}

export interface ProcessingJob {
  id: string;
  job_type: string;
  edition_id: string | null;
  target: unknown | null;
  status: JobStatus;
  retry_count: number;
  last_error: unknown | null;
  last_attempt_at: Date | null;
  next_eligible_at: Date;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface Database {
  processing_jobs: {
    id: Generated<string>;
    job_type: string;
    edition_id: string | null;
    target: unknown | null;
    status: Generated<JobStatus>;
    retry_count: Generated<number>;
    last_error: unknown | null;
    last_attempt_at: Date | null;
    next_eligible_at: Generated<Date>;
    locked_by: string | null;
    locked_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    completed_at: Date | null;
  };
  editions: {
    id: Generated<string>;
    publication_date: Date;
    status: Generated<EditionStatus>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    published_at: Date | null;
    failed_at: Date | null;
    failure_reason: string | null;
    metadata: unknown | null;
  };
}

export function createKysely(pool: PgPool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function closeKysely(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
