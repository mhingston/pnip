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
  closeKysely,
  type Database,
  type ProcessingJob,
} from "../../database/kysely.js";
import {
  createProcessingJobQueue,
  type ProcessingJobQueue,
} from "../queue/processing-job-queue.js";
import { createLogger } from "../../logging/logger.js";
import { createWorkerRuntime } from "./worker-runtime.js";
import type { Worker } from "./worker.js";

const migrationSqlPath = fileURLToPath(
  new URL(
    "../../database/migrations/002_create_processing_jobs.sql",
    import.meta.url,
  ),
);
const migration006SqlPath = fileURLToPath(
  new URL(
    "../../database/migrations/006_add_depends_on_to_processing_jobs.sql",
    import.meta.url,
  ),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function readMigration006Sql(): Promise<string> {
  return readFile(migration006SqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("WorkerRuntime", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let queue: ProcessingJobQueue;
  const schema = schemaName("worker_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const sqlText = await readMigrationSql();
    const sql006Text = await readMigration006Sql();
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(sqlText);
      await client.query(sql006Text);
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

  function silentLogger() {
    return createLogger({ sink: () => {}, level: "error" });
  }

  async function rowCount(): Promise<number> {
    const rows = await db.selectFrom("processing_jobs").selectAll().execute();
    return rows.length;
  }

  it("success path: parent completed + child enqueued, execute called once", async () => {
    let executeCalls = 0;
    let receivedJob: ProcessingJob | undefined;
    const echoWorker: Worker = {
      supports: (t) => t === "echo",
      execute: async (job) => {
        executeCalls += 1;
        receivedJob = job;
        return {
          childJobs: [{ jobType: "child", editionId: job.edition_id ?? undefined }],
        };
      },
    };
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [echoWorker],
      logger: silentLogger(),
    });

    const enqueued = await queue.enqueue({ jobType: "echo" });
    const result = await runtime.runOne("w1");
    expect(result).toBe(true);

    expect(executeCalls).toBe(1);
    expect(receivedJob).toBeDefined();
    expect(receivedJob!.id).toBe(enqueued.id);
    expect(receivedJob!.status).toBe("running");

    const parent = await queue.getJob(enqueued.id);
    expect(parent).toBeDefined();
    expect(parent!.status).toBe("completed");
    expect(parent!.completed_at).toBeInstanceOf(Date);

    const children = await db
      .selectFrom("processing_jobs")
      .selectAll()
      .where("job_type", "=", "child")
      .execute();
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("pending");
  });

  it("no worker for type: job failed with NoWorkerError, retry_count=1, no children", async () => {
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [],
      logger: silentLogger(),
    });

    const enqueued = await queue.enqueue({ jobType: "mystery" });
    const result = await runtime.runOne("w1");
    expect(result).toBe(true);

    const job = await queue.getJob(enqueued.id);
    expect(job).toBeDefined();
    expect(job!.status).toBe("failed");
    expect((job!.last_error as { type: string }).type).toBe("NoWorkerError");
    expect(job!.retry_count).toBe(1);

    expect(await rowCount()).toBe(1);
  });

  it("worker throws with maxAttempts=1: permanent failure, retry_count=1, no children", async () => {
    const boomWorker: Worker = {
      supports: (t) => t === "boom",
      execute: async () => {
        throw new Error("boom");
      },
    };
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [boomWorker],
      logger: silentLogger(),
      retry: { maxAttempts: 1 },
    });

    const enqueued = await queue.enqueue({ jobType: "boom" });
    const result = await runtime.runOne("w1");
    expect(result).toBe(true);

    const job = await queue.getJob(enqueued.id);
    expect(job).toBeDefined();
    expect(job!.status).toBe("failed");
    const err = job!.last_error as {
      type: string;
      message: string;
      stack?: string;
    };
    expect(err.type).toBe("Error");
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
    expect(err.stack!.length).toBeGreaterThan(0);
    expect(job!.retry_count).toBe(1);

    expect(await rowCount()).toBe(1);
  });

  it("worker throws with retries remaining: pending + future next_eligible_at, retry→permanent boundary", async () => {
    const boomWorker: Worker = {
      supports: (t) => t === "boom",
      execute: async () => {
        throw new Error("boom");
      },
    };
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [boomWorker],
      logger: silentLogger(),
      retry: { maxAttempts: 3, jitter: false },
    });

    const enqueued = await queue.enqueue({ jobType: "boom" });

    // Attempt 1: retry_count 0→1, 1 < 3 → pending, next_eligible_at ≈ now+30s
    await runtime.runOne("w1");
    let job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(1);
    expect(job!.locked_by).toBeNull();
    expect(job!.locked_at).toBeNull();
    const err1 = job!.last_error as { type: string; message: string };
    expect(err1.type).toBe("Error");
    expect(err1.message).toBe("boom");
    const now1 = Date.now();
    const next1 = job!.next_eligible_at.getTime();
    expect(next1).toBeGreaterThan(now1 + 29_000);
    expect(next1).toBeLessThan(now1 + 31_000);

    // Not claimable yet (future next_eligible_at)
    const notYet = await queue.claim("w1");
    expect(notYet).toBeNull();

    // Simulate time passing: make it eligible
    await db
      .updateTable("processing_jobs")
      .set({ next_eligible_at: sql`now()` })
      .where("id", "=", enqueued.id)
      .execute();

    // Attempt 2: retry_count 1→2, 2 < 3 → pending, next_eligible_at ≈ now+120s
    await runtime.runOne("w1");
    job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("pending");
    expect(job!.retry_count).toBe(2);
    expect(job!.locked_by).toBeNull();
    const now2 = Date.now();
    const next2 = job!.next_eligible_at.getTime();
    expect(next2).toBeGreaterThan(now2 + 119_000);
    expect(next2).toBeLessThan(now2 + 121_000);

    // Make eligible again
    await db
      .updateTable("processing_jobs")
      .set({ next_eligible_at: sql`now()` })
      .where("id", "=", enqueued.id)
      .execute();

    // Attempt 3: retry_count 2→3, 3 < 3 false → failed (permanent)
    await runtime.runOne("w1");
    job = await queue.getJob(enqueued.id);
    expect(job!.status).toBe("failed");
    expect(job!.retry_count).toBe(3);

    expect(await rowCount()).toBe(1);
  });

  it("no worker for type stays permanent failed even with maxAttempts configured", async () => {
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [],
      logger: silentLogger(),
      retry: { maxAttempts: 3 },
    });

    const enqueued = await queue.enqueue({ jobType: "mystery" });
    const result = await runtime.runOne("w1");
    expect(result).toBe(true);

    const job = await queue.getJob(enqueued.id);
    expect(job).toBeDefined();
    expect(job!.status).toBe("failed");
    expect((job!.last_error as { type: string }).type).toBe("NoWorkerError");
    expect(job!.retry_count).toBe(1);

    expect(await rowCount()).toBe(1);
  });

  it("empty queue: runOne returns false, no state changes", async () => {
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [],
      logger: silentLogger(),
    });
    const result = await runtime.runOne("w1");
    expect(result).toBe(false);
    expect(await rowCount()).toBe(0);
  });

  it("atomicity: children+complete roll back together if enqueue fails mid-transaction", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const atomWorker: Worker = {
      supports: (t) => t === "atom",
      execute: async () => ({
        childJobs: [
          { jobType: "good_child" },
          { jobType: "bad_child", target: circular },
        ],
      }),
    };
    const runtime = createWorkerRuntime({
      db,
      queue,
      workers: [atomWorker],
      logger: silentLogger(),
    });

    const enqueued = await queue.enqueue({ jobType: "atom" });
    await expect(runtime.runOne("w1")).rejects.toThrow();

    const parent = await queue.getJob(enqueued.id);
    expect(parent).toBeDefined();
    expect(parent!.status).toBe("running");
    expect(parent!.completed_at).toBeNull();

    const children = await db
      .selectFrom("processing_jobs")
      .selectAll()
      .where("job_type", "in", ["good_child", "bad_child"])
      .execute();
    expect(children).toHaveLength(0);
  });
});
