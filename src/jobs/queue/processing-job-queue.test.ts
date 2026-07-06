import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, CompiledQuery, sql } from "kysely";
import { loadConfig } from "../../config/index.js";
import { createPool, closePool, type PgPool } from "../../database/pool.js";
import {
  createKysely,
  closeKysely,
  type Database,
  type ProcessingJob,
} from "../../database/kysely.js";
import {
  createProcessingJobQueue,
  type ProcessingJobQueue,
} from "./processing-job-queue.js";

const migrationSqlPath = fileURLToPath(
  new URL("../../database/migrations/002_create_processing_jobs.sql", import.meta.url),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("ProcessingJobQueue", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let queue: ProcessingJobQueue;
  const schema = schemaName("queue_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const sqlText = await readMigrationSql();
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(sqlText);
    } finally {
      client.release();
    }

    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: kyselyPool,
        onReserveConnection: async (conn) => {
          await conn.executeQuery(
            CompiledQuery.raw(`SET search_path TO ${schema}, public`),
          );
        },
      }),
    });
    queue = createProcessingJobQueue(db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.processing_jobs`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  it("claims a pending job and marks it running, then returns null when none pending", async () => {
    const enqueued = await queue.enqueue({ jobType: "fetch" });
    expect(enqueued.status).toBe("pending");
    expect(enqueued.id).toBeTruthy();

    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(enqueued.id);
    expect(claimed!.status).toBe("running");
    expect(claimed!.locked_by).toBe("w1");
    expect(claimed!.locked_at).toBeInstanceOf(Date);
    expect(claimed!.last_attempt_at).toBeInstanceOf(Date);

    const again = await queue.claim("w1");
    expect(again).toBeNull();
  });

  it("completes a claimed job", async () => {
    const enqueued = await queue.enqueue({ jobType: "fetch" });
    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();

    await queue.complete(enqueued.id);

    const after = await queue.getJob(enqueued.id);
    expect(after).toBeDefined();
    expect(after!.status).toBe("completed");
    expect(after!.completed_at).toBeInstanceOf(Date);
  });

  it("concurrent workers claim distinct jobs via FOR UPDATE SKIP LOCKED", async () => {
    const j1 = await queue.enqueue({ jobType: "fetch" });
    const j2 = await queue.enqueue({ jobType: "fetch" });
    expect(j1.id).not.toBe(j2.id);

    const [a, b] = await Promise.all([queue.claim("w1"), queue.claim("w2")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);

    const third = await queue.claim("w3");
    expect(third).toBeNull();

    await pool.query(
      `INSERT INTO ${schema}.processing_jobs (job_type, status) VALUES ('manual_running', 'running')`,
    );
    const afterRunning = await queue.claim("w3");
    expect(afterRunning).toBeNull();
  });

  it("recoverStaleJobs resets a stale running job to pending and makes it re-claimable", async () => {
    const enqueued = await queue.enqueue({ jobType: "stale" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='dead', locked_at = now() - interval '10 minutes' WHERE id = $1`,
      [enqueued.id],
    );

    const count = await queue.recoverStaleJobs(5 * 60 * 1000);
    expect(count).toBe(1);

    const job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(1);
    expect(job!.locked_by).toBeNull();
    expect(job!.locked_at).toBeNull();
    expect(job!.last_attempt_at).toBeInstanceOf(Date);
    const err = job!.last_error as {
      type: string;
      message: string;
      recovered_at: string;
    };
    expect(err.type).toBe("StaleJobError");
    expect(err.message).toContain("running");
    expect(typeof err.recovered_at).toBe("string");
    expect(err.recovered_at.length).toBeGreaterThan(0);

    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(enqueued.id);
    expect(claimed!.status).toBe("running");
  });

  it("recoverStaleJobs leaves recent running jobs untouched", async () => {
    const enqueued = await queue.enqueue({ jobType: "recent" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='w1', locked_at = now() WHERE id = $1`,
      [enqueued.id],
    );

    const count = await queue.recoverStaleJobs(5 * 60 * 1000);
    expect(count).toBe(0);

    const job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("running");
    expect(job!.locked_by).toBe("w1");
    expect(job!.retry_count).toBe(0);
  });

  it("recoverStaleJobs fails a stale job once retry_count reaches maxAttempts", async () => {
    const enqueued = await queue.enqueue({ jobType: "stalemax" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='dead', locked_at = now() - interval '10 minutes', retry_count = 2 WHERE id = $1`,
      [enqueued.id],
    );

    const count = await queue.recoverStaleJobs(5 * 60 * 1000, { maxAttempts: 3 });
    expect(count).toBe(1);

    const job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("failed");
    expect(job!.retry_count).toBe(3);
    expect((job!.last_error as { type: string }).type).toBe("StaleJobError");

    const notClaimable = await queue.claim("w1");
    expect(notClaimable).toBeNull();
  });

  it("recoverStaleJobs only touches running jobs (pending/completed untouched)", async () => {
    const pending = await queue.enqueue({ jobType: "pend" });
    const completed = await queue.enqueue({ jobType: "done" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at = now(), locked_at = now() - interval '10 minutes' WHERE id = $1`,
      [completed.id],
    );

    const count = await queue.recoverStaleJobs(5 * 60 * 1000);
    expect(count).toBe(0);

    const p = await queue.getJob(pending.id);
    expect(p!.status).toBe("pending");
    expect(p!.retry_count).toBe(0);
    const c = await queue.getJob(completed.id);
    expect(c!.status).toBe("completed");
    expect(c!.retry_count).toBe(0);
  });

  it("002 migration creates processing_jobs with required columns in a fresh schema", async () => {
    const tmp = schemaName("queue_mig_");
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${tmp}`);
      await client.query(`SET search_path TO ${tmp}, public`);
      await client.query(await readMigrationSql());

      const res = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'processing_jobs'`,
        [tmp],
      );
      const cols = new Set(
        res.rows.map((r: { column_name: string }) => r.column_name),
      );
      for (const c of [
        "id",
        "job_type",
        "status",
        "next_eligible_at",
        "locked_by",
        "locked_at",
        "completed_at",
      ]) {
        expect(cols.has(c)).toBe(true);
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${tmp} CASCADE`);
      client.release();
    }
  });
});

describe("createKysely / closeKysely", () => {
  let pool: PgPool;
  let db: Kysely<Database>;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    db = createKysely(pool);
  });

  afterAll(async () => {
    await closeKysely(db);
  });

  it("builds a Kysely instance that can execute a query against the pool", async () => {
    const result = await sql`SELECT 1 AS ok`.execute(db);
    expect((result.rows[0] as { ok: number }).ok).toBe(1);
  });
});
