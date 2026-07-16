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

  it("can scope claims to one edition without touching another edition's jobs", async () => {
    const targetEdition = randomUUID();
    const otherEdition = randomUUID();
    const other = await queue.enqueue({
      jobType: "other",
      editionId: otherEdition,
    });
    const target = await queue.enqueue({
      jobType: "target",
      editionId: targetEdition,
    });

    const claimed = await queue.claim("w1", { editionId: targetEdition });

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(target.id);
    expect((await queue.getJob(other.id))!.status).toBe("pending");
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

  it("default claimable: a job enqueued with no dependsOn is immediately claimable and has empty depends_on", async () => {
    const enqueued = await queue.enqueue({ jobType: "nodep" });
    expect(enqueued.depends_on).toEqual([]);

    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(enqueued.id);
    expect(claimed!.status).toBe("running");
  });

  it("blocked by incomplete dep: B dependsOn=[A], claim returns A then null while A incomplete", async () => {
    const A = await queue.enqueue({ jobType: "a" });
    const B = await queue.enqueue({ jobType: "b", dependsOn: [A.id] });
    expect(B.depends_on).toEqual([A.id]);

    const claimedA = await queue.claim("w1");
    expect(claimedA).not.toBeNull();
    expect(claimedA!.id).toBe(A.id);

    const second = await queue.claim("w1");
    expect(second).toBeNull();
  });

  it("unblocks on completion: after A completes, B becomes claimable and is marked running", async () => {
    const A = await queue.enqueue({ jobType: "a" });
    const B = await queue.enqueue({ jobType: "b", dependsOn: [A.id] });

    const claimedA = await queue.claim("w1");
    expect(claimedA!.id).toBe(A.id);
    await queue.complete(A.id);

    const claimedB = await queue.claim("w1");
    expect(claimedB).not.toBeNull();
    expect(claimedB!.id).toBe(B.id);
    expect(claimedB!.status).toBe("running");
  });

  it("failed dep stays blocked: A='failed' keeps B blocked (only 'completed' unblocks)", async () => {
    const A = await queue.enqueue({ jobType: "a" });
    await queue.enqueue({ jobType: "b", dependsOn: [A.id] });

    const claimedA = await queue.claim("w1");
    expect(claimedA!.id).toBe(A.id);

    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed' WHERE id = $1`,
      [A.id],
    );

    const claimed = await queue.claim("w1");
    expect(claimed).toBeNull();
  });

  it("multiple deps: B dependsOn=[A,C] unblocks only when BOTH completed", async () => {
    const A = await queue.enqueue({ jobType: "a" });
    const C = await queue.enqueue({ jobType: "c" });
    const B = await queue.enqueue({ jobType: "b", dependsOn: [A.id, C.id] });
    expect(B.depends_on).toEqual([A.id, C.id]);

    const claimedA = await queue.claim("w1");
    expect(claimedA!.id).toBe(A.id);
    await queue.complete(A.id);

    const mid = await queue.claim("w1");
    expect(mid).not.toBeNull();
    expect(mid!.id).toBe(C.id);

    const stillBlocked = await queue.claim("w1");
    expect(stillBlocked).toBeNull();

    await queue.complete(C.id);

    const claimedB = await queue.claim("w1");
    expect(claimedB).not.toBeNull();
    expect(claimedB!.id).toBe(B.id);
    expect(claimedB!.status).toBe("running");
  });

  it("GIN index processing_jobs_depends_on_idx exists in the per-run schema", async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'processing_jobs_depends_on_idx'`,
      [schema],
    );
    expect(r.rows.length).toBe(1);
  });

  it("archiveJobs archives a completed job and bumps updated_at", async () => {
    const enqueued = await queue.enqueue({ jobType: "done" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() - interval '1 hour' WHERE id = $1`,
      [enqueued.id],
    );
    const before = await queue.getJob(enqueued.id);
    expect(before!.status).toBe("completed");

    const count = await queue.archiveJobs({});
    expect(count).toBe(1);

    const after = await queue.getJob(enqueued.id);
    expect(after!.status).toBe("archived");
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });

  it("default statuses covers completed AND failed", async () => {
    const c = await queue.enqueue({ jobType: "c" });
    const f = await queue.enqueue({ jobType: "f" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [c.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed' WHERE id = $1`,
      [f.id],
    );

    const count = await queue.archiveJobs({});
    expect(count).toBe(2);

    const cAfter = await queue.getJob(c.id);
    expect(cAfter!.status).toBe("archived");
    const fAfter = await queue.getJob(f.id);
    expect(fAfter!.status).toBe("archived");
  });

  it("pending and running jobs are not archived", async () => {
    const completed = await queue.enqueue({ jobType: "done" });
    const pending = await queue.enqueue({ jobType: "pend" });
    const running = await queue.enqueue({ jobType: "run" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [completed.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='w1', locked_at=now() WHERE id = $1`,
      [running.id],
    );

    const count = await queue.archiveJobs({});
    expect(count).toBe(1);

    const cAfter = await queue.getJob(completed.id);
    expect(cAfter!.status).toBe("archived");
    const pAfter = await queue.getJob(pending.id);
    expect(pAfter!.status).toBe("pending");
    const rAfter = await queue.getJob(running.id);
    expect(rAfter!.status).toBe("running");
  });

  it("age filter archives only jobs older than olderThanMs", async () => {
    const old = await queue.enqueue({ jobType: "old" });
    const recent = await queue.enqueue({ jobType: "recent" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() - interval '1 hour' WHERE id = $1`,
      [old.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() WHERE id = $1`,
      [recent.id],
    );

    const count = await queue.archiveJobs({ olderThanMs: 30 * 60 * 1000 });
    expect(count).toBe(1);

    const oldAfter = await queue.getJob(old.id);
    expect(oldAfter!.status).toBe("archived");
    const recentAfter = await queue.getJob(recent.id);
    expect(recentAfter!.status).toBe("completed");
  });

  it("limit archives only the N oldest matching jobs by updated_at", async () => {
    const a = await queue.enqueue({ jobType: "a" });
    const b = await queue.enqueue({ jobType: "b" });
    const c = await queue.enqueue({ jobType: "c" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() - interval '1 hour' WHERE id = $1`,
      [a.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() - interval '2 hours' WHERE id = $1`,
      [b.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now(), updated_at = now() - interval '3 hours' WHERE id = $1`,
      [c.id],
    );

    const count = await queue.archiveJobs({ limit: 2 });
    expect(count).toBe(2);

    const aAfter = await queue.getJob(a.id);
    const bAfter = await queue.getJob(b.id);
    const cAfter = await queue.getJob(c.id);
    expect(aAfter!.status).toBe("completed");
    expect(bAfter!.status).toBe("archived");
    expect(cAfter!.status).toBe("archived");
  });

  it("archiveJobs is idempotent: a second call returns 0", async () => {
    const c = await queue.enqueue({ jobType: "done" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [c.id],
    );

    const first = await queue.archiveJobs({});
    expect(first).toBe(1);

    const second = await queue.archiveJobs({});
    expect(second).toBe(0);

    const after = await queue.getJob(c.id);
    expect(after!.status).toBe("archived");
  });

  it("archived jobs are not claimable", async () => {
    const archived = await queue.enqueue({ jobType: "done" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [archived.id],
    );
    await queue.archiveJobs({});

    const none = await queue.claim("w1");
    expect(none).toBeNull();

    const pending = await queue.enqueue({ jobType: "fresh" });
    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(pending.id);
    expect(claimed!.status).toBe("running");
  });

  it("custom statuses: archiveJobs({ statuses: ['completed'] }) leaves failed untouched", async () => {
    const c = await queue.enqueue({ jobType: "c" });
    const f = await queue.enqueue({ jobType: "f" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [c.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed' WHERE id = $1`,
      [f.id],
    );

    const count = await queue.archiveJobs({ statuses: ["completed"] });
    expect(count).toBe(1);

    const cAfter = await queue.getJob(c.id);
    expect(cAfter!.status).toBe("archived");
    const fAfter = await queue.getJob(f.id);
    expect(fAfter!.status).toBe("failed");
  });

  it("purgeArchivedJobs DELETEs only archived rows and leaves completed untouched", async () => {
    const archived = await queue.enqueue({ jobType: "a" });
    const completed = await queue.enqueue({ jobType: "c" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='archived' WHERE id = $1`,
      [archived.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [completed.id],
    );

    const purged = await queue.purgeArchivedJobs({});
    expect(purged).toBe(1);

    expect(await queue.getJob(archived.id)).toBeUndefined();
    const cAfter = await queue.getJob(completed.id);
    expect(cAfter).toBeDefined();
    expect(cAfter!.status).toBe("completed");
  });

  it("purgeArchivedJobs respects the age filter and leaves recent archived rows", async () => {
    const oldArchived = await queue.enqueue({ jobType: "old" });
    const freshArchived = await queue.enqueue({ jobType: "fresh" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='archived', updated_at = now() - interval '2 hours' WHERE id = $1`,
      [oldArchived.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='archived' WHERE id = $1`,
      [freshArchived.id],
    );

    const purged = await queue.purgeArchivedJobs({ olderThanMs: 60 * 60 * 1000 });
    expect(purged).toBe(1);
    expect(await queue.getJob(oldArchived.id)).toBeUndefined();
    const freshAfter = await queue.getJob(freshArchived.id);
    expect(freshAfter).toBeDefined();
    expect(freshAfter!.status).toBe("archived");
  });

  it("purgeArchivedJobs respects the limit and purges oldest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = await queue.enqueue({ jobType: `t${i}` });
      await pool.query(
        `UPDATE ${schema}.processing_jobs SET status='archived', updated_at = now() - ($1 * interval '1 minute') WHERE id = $2`,
        [10 * (4 - i), j.id],
      );
      ids.push(j.id);
    }

    const purged = await queue.purgeArchivedJobs({ limit: 2 });
    expect(purged).toBe(2);
    expect(await queue.getJob(ids[0])).toBeUndefined();
    expect(await queue.getJob(ids[1])).toBeUndefined();
    expect(await queue.getJob(ids[2])).toBeDefined();
    expect(await queue.getJob(ids[3])).toBeDefined();
  });

  it("purgeArchivedJobs with no matching rows returns 0 (idempotent)", async () => {
    expect(await queue.purgeArchivedJobs({})).toBe(0);
    const j = await queue.enqueue({ jobType: "pending" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='pending' WHERE id = $1`,
      [j.id],
    );
    expect(await queue.purgeArchivedJobs({})).toBe(0);
  });

  it("countByStatus returns 0 for empty statuses and exact counts after enqueue + archive", async () => {
    const a = await queue.enqueue({ jobType: "a" });
    const b = await queue.enqueue({ jobType: "b" });
    const c = await queue.enqueue({ jobType: "c" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed' WHERE id IN ($1, $2)`,
      [a.id, b.id],
    );
    await queue.archiveJobs({});
    const counts = await queue.countByStatus();
    expect(counts).toEqual({ pending: 1, running: 0, completed: 0, failed: 0, archived: 2 });
    expect(c.id).toBeTruthy();
  });

  it("cancelForEdition marks pending and running jobs for the edition as failed", async () => {
    const editionId = randomUUID();
    const otherEdition = randomUUID();
    const pending1 = await queue.enqueue({ jobType: "a", editionId });
    const pending2 = await queue.enqueue({ jobType: "b", editionId });
    const running1 = await queue.enqueue({ jobType: "c", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='w1', locked_at=now() WHERE id = $1`,
      [running1.id],
    );
    const other = await queue.enqueue({ jobType: "d", editionId: otherEdition });

    const cancelled = await queue.cancelForEdition({
      editionId,
      reason: "edition published",
    });
    expect(cancelled).toBe(3);

    for (const j of [pending1, pending2, running1]) {
      const after = await queue.getJob(j.id);
      expect(after).toBeDefined();
      expect(after!.status).toBe("failed");
      const err = after!.last_error as { type: string; message: string };
      expect(err.type).toBe("JobCancelledError");
      expect(err.message).toContain("edition published");
    }
    const otherAfter = await queue.getJob(other.id);
    expect(otherAfter).toBeDefined();
    expect(otherAfter!.status).toBe("pending");
    expect(otherAfter!.last_error).toBeNull();
  });

  it("cancelForEdition returns 0 when no mutable jobs exist for the edition", async () => {
    const editionId = randomUUID();
    const completed = await queue.enqueue({ jobType: "c", editionId });
    const archived = await queue.enqueue({ jobType: "a", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [completed.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='archived' WHERE id = $1`,
      [archived.id],
    );

    const cancelled = await queue.cancelForEdition({
      editionId,
      reason: "should not affect anything",
    });
    expect(cancelled).toBe(0);

    expect((await queue.getJob(completed.id))!.status).toBe("completed");
    expect((await queue.getJob(archived.id))!.status).toBe("archived");
  });

  it("cancelForEdition records the reason in last_error", async () => {
    const editionId = randomUUID();
    const j = await queue.enqueue({ jobType: "x", editionId });
    const reason = "operator triggered cancel: hotfix-2026-07-07";

    const cancelled = await queue.cancelForEdition({ editionId, reason });
    expect(cancelled).toBe(1);

    const after = await queue.getJob(j.id);
    expect(after).toBeDefined();
    expect(after!.status).toBe("failed");
    const err = after!.last_error as { type: string; message: string };
    expect(err.type).toBe("JobCancelledError");
    expect(err.message).toContain(reason);
  });

  it("cancelForEdition sets last_attempt_at and updated_at to now", async () => {
    const editionId = randomUUID();
    const j = await queue.enqueue({ jobType: "ts", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET last_attempt_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' WHERE id = $1`,
      [j.id],
    );
    const before = await queue.getJob(j.id);
    expect(before!.last_attempt_at).toBeInstanceOf(Date);
    expect(before!.updated_at).toBeInstanceOf(Date);
    const beforeLastAttempt = before!.last_attempt_at!.getTime();
    const beforeUpdated = before!.updated_at.getTime();

    const cancelled = await queue.cancelForEdition({
      editionId,
      reason: "stale",
    });
    expect(cancelled).toBe(1);

    const after = await queue.getJob(j.id);
    expect(after!.last_attempt_at).toBeInstanceOf(Date);
    expect(after!.updated_at).toBeInstanceOf(Date);
    expect(after!.last_attempt_at!.getTime()).toBeGreaterThan(beforeLastAttempt);
    expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(beforeUpdated);
  });

  it("cancelForEdition returns 0 for an edition with no rows at all", async () => {
    const cancelled = await queue.cancelForEdition({
      editionId: randomUUID(),
      reason: "ghost edition",
    });
    expect(cancelled).toBe(0);
  });

  it("cancelForEdition cancels a running job, not just pending ones", async () => {
    const editionId = randomUUID();
    const j = await queue.enqueue({ jobType: "run", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='w1', locked_at=now() WHERE id = $1`,
      [j.id],
    );

    const cancelled = await queue.cancelForEdition({
      editionId,
      reason: "stop running job",
    });
    expect(cancelled).toBe(1);

    const after = await queue.getJob(j.id);
    expect(after!.status).toBe("failed");
    const err = after!.last_error as { type: string; message: string };
    expect(err.type).toBe("JobCancelledError");
    expect(err.message).toContain("stop running job");
  });

  it("cancelForEdition cancels both pending and running jobs in a single call", async () => {
    const editionId = randomUUID();
    const pending = await queue.enqueue({ jobType: "p", editionId });
    const running = await queue.enqueue({ jobType: "r", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='running', locked_by='w1', locked_at=now() WHERE id = $1`,
      [running.id],
    );

    const cancelled = await queue.cancelForEdition({
      editionId,
      reason: "publishing",
    });
    expect(cancelled).toBe(2);

    const p = await queue.getJob(pending.id);
    const r = await queue.getJob(running.id);
    expect(p!.status).toBe("failed");
    expect(r!.status).toBe("failed");
    expect((p!.last_error as { type: string }).type).toBe("JobCancelledError");
    expect((r!.last_error as { type: string }).type).toBe("JobCancelledError");
  });

  it("listFailed returns all failed jobs ordered by updated_at desc", async () => {
    const e1 = randomUUID();
    const a = await queue.enqueue({ jobType: "a", editionId: e1 });
    const b = await queue.enqueue({ jobType: "b", editionId: e1 });
    const c = await queue.enqueue({ jobType: "c", editionId: e1 });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', updated_at = now() - interval '3 hours' WHERE id = $1`,
      [a.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', updated_at = now() - interval '1 hour' WHERE id = $1`,
      [b.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', updated_at = now() - interval '2 hours' WHERE id = $1`,
      [c.id],
    );
    const pending = await queue.enqueue({ jobType: "p" });

    const rows = await queue.listFailed({});
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(rows.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(rows.every((r) => r.status === "failed")).toBe(true);

    const pendingAfter = await queue.getJob(pending.id);
    expect(pendingAfter!.status).toBe("pending");
  });

  it("listFailed filters by editionId and jobType", async () => {
    const e1 = randomUUID();
    const e2 = randomUUID();
    const a = await queue.enqueue({ jobType: "expand_document", editionId: e1 });
    const b = await queue.enqueue({ jobType: "chunk_document", editionId: e1 });
    const c = await queue.enqueue({ jobType: "expand_document", editionId: e2 });
    for (const id of [a.id, b.id, c.id]) {
      await pool.query(
        `UPDATE ${schema}.processing_jobs SET status='failed' WHERE id = $1`,
        [id],
      );
    }

    const byEdition = await queue.listFailed({ editionId: e1 });
    expect(byEdition.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const byJobType = await queue.listFailed({ jobType: "expand_document" });
    expect(byJobType.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());

    const both = await queue.listFailed({
      editionId: e1,
      jobType: "chunk_document",
    });
    expect(both.map((r) => r.id)).toEqual([b.id]);
  });

  it("listFailed respects the olderThanMs age filter", async () => {
    const editionId = randomUUID();
    const old = await queue.enqueue({ jobType: "old", editionId });
    const recent = await queue.enqueue({ jobType: "recent", editionId });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', updated_at = now() - interval '2 hours' WHERE id = $1`,
      [old.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', updated_at = now() WHERE id = $1`,
      [recent.id],
    );

    const rows = await queue.listFailed({ olderThanMs: 30 * 60 * 1000 });
    expect(rows.map((r) => r.id)).toEqual([old.id]);
    expect(rows.find((r) => r.id === recent.id)).toBeUndefined();
  });

  it("requeue resets failed jobs to pending, clears retry_count/last_error/lock state, and is idempotent", async () => {
    const e1 = randomUUID();
    const a = await queue.enqueue({ jobType: "a", editionId: e1 });
    const b = await queue.enqueue({ jobType: "b", editionId: e1 });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', retry_count=4, last_error='{"type":"X","message":"boom"}'::jsonb, locked_by='w1', locked_at = now(), last_attempt_at = now() - interval '1 minute' WHERE id = $1`,
      [a.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', retry_count=2 WHERE id = $1`,
      [b.id],
    );

    const first = await queue.requeue([a.id, b.id]);
    expect(first).toBe(2);

    const aAfter = await queue.getJob(a.id);
    expect(aAfter!.status).toBe("pending");
    expect(aAfter!.retry_count).toBe(0);
    expect(aAfter!.last_error).toBeNull();
    expect(aAfter!.locked_by).toBeNull();
    expect(aAfter!.locked_at).toBeNull();
    expect(aAfter!.last_attempt_at).toBeNull();
    expect(aAfter!.next_eligible_at).toBeInstanceOf(Date);

    const bAfter = await queue.getJob(b.id);
    expect(bAfter!.status).toBe("pending");
    expect(bAfter!.retry_count).toBe(0);

    const second = await queue.requeue([a.id, b.id]);
    expect(second).toBe(0);

    const claimed = await queue.claim("w1");
    expect(claimed).not.toBeNull();
    expect([a.id, b.id]).toContain(claimed!.id);
    expect(claimed!.status).toBe("running");
  });

  it("requeue skips rows whose status is not 'failed'", async () => {
    const pending = await queue.enqueue({ jobType: "p" });
    const completed = await queue.enqueue({ jobType: "c" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at=now() WHERE id = $1`,
      [completed.id],
    );

    const count = await queue.requeue([pending.id, completed.id]);
    expect(count).toBe(0);

    const p = await queue.getJob(pending.id);
    expect(p!.status).toBe("pending");
    const c = await queue.getJob(completed.id);
    expect(c!.status).toBe("completed");
  });

  it("requeue returns 0 for an empty id list without touching the DB", async () => {
    const count = await queue.requeue([]);
    expect(count).toBe(0);
  });

  it("getMetrics on an empty table returns zero counts and null latency/age", async () => {
    const m = await queue.getMetrics();
    expect(m.byStatus).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      archived: 0,
    });
    expect(m.totalCompleted).toBe(0);
    expect(m.totalFailed).toBe(0);
    expect(m.totalRetries).toBe(0);
    expect(m.maxRetries).toBe(0);
    expect(m.avgProcessingLatencyMs).toBeNull();
    expect(m.throughputLastHour).toBe(0);
    expect(m.throughputLastDay).toBe(0);
    expect(m.oldestPendingAgeMs).toBeNull();
  });

  it("getMetrics reports avg latency and throughput for completed jobs", async () => {
    const recent = await queue.enqueue({ jobType: "fast" });
    const older = await queue.enqueue({ jobType: "slow" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at = now(), created_at = now() - interval '30 seconds' WHERE id = $1`,
      [recent.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='completed', completed_at = now() - interval '2 hours', created_at = now() - interval '3 hours' WHERE id = $1`,
      [older.id],
    );

    const m = await queue.getMetrics();
    expect(m.byStatus.completed).toBe(2);
    expect(m.totalCompleted).toBe(2);
    expect(m.totalFailed).toBe(0);
    expect(m.throughputLastHour).toBe(1);
    expect(m.throughputLastDay).toBe(2);
    expect(m.avgProcessingLatencyMs).not.toBeNull();
    expect(m.avgProcessingLatencyMs!).toBeGreaterThan(0);
    expect(m.oldestPendingAgeMs).toBeNull();
  });

  it("getMetrics reports totalRetries, maxRetries, totalFailed, and oldest pending age", async () => {
    const pending = await queue.enqueue({ jobType: "stuck" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='pending', created_at = now() - interval '5 minutes' WHERE id = $1`,
      [pending.id],
    );
    const failedA = await queue.enqueue({ jobType: "fa" });
    const failedB = await queue.enqueue({ jobType: "fb" });
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', retry_count = 2 WHERE id = $1`,
      [failedA.id],
    );
    await pool.query(
      `UPDATE ${schema}.processing_jobs SET status='failed', retry_count = 5 WHERE id = $1`,
      [failedB.id],
    );

    const m = await queue.getMetrics();
    expect(m.byStatus.failed).toBe(2);
    expect(m.byStatus.pending).toBe(1);
    expect(m.totalFailed).toBe(2);
    expect(m.totalRetries).toBe(7);
    expect(m.maxRetries).toBe(5);
    expect(m.oldestPendingAgeMs).not.toBeNull();
    expect(m.oldestPendingAgeMs!).toBeGreaterThan(4 * 60 * 1000);
    expect(m.throughputLastHour).toBe(0);
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
