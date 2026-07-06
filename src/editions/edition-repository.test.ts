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
import { Kysely, PostgresDialect, CompiledQuery } from "kysely";
import { loadConfig } from "../config/index.js";
import { createPool, closePool, type PgPool } from "../database/pool.js";
import {
  closeKysely,
  type Database,
  type Edition,
} from "../database/kysely.js";
import {
  createEditionRepository,
  EDITION_TRANSITIONS,
  EditionNotFoundError,
  InvalidEditionTransitionError,
  EditionConcurrentUpdateError,
  type EditionRepository,
} from "./edition-repository.js";

const migrationSqlPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EditionRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: EditionRepository;
  const schema = schemaName("edition_test_");

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
    repo = createEditionRepository(db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.editions`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  it("EDITION_TRANSITIONS marks published as having no outgoing transitions", () => {
    expect(EDITION_TRANSITIONS.published).toEqual([]);
    expect(EDITION_TRANSITIONS.building).toEqual(["ready", "failed"]);
    expect(EDITION_TRANSITIONS.ready).toEqual(["publishing", "failed"]);
    expect(EDITION_TRANSITIONS.publishing).toEqual(["published", "failed"]);
    expect(EDITION_TRANSITIONS.failed).toEqual(["building"]);
  });

  it("create + getById: creates an edition in building status and fetches it by id", async () => {
    const created = await repo.create("2026-01-01");
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("building");
    expect(created.publication_date).toBeInstanceOf(Date);
    expect(created.published_at).toBeNull();
    expect(created.failed_at).toBeNull();
    expect(created.failure_reason).toBeNull();

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.status).toBe("building");
  });

  it("getByDate: returns the edition by publication_date, undefined when absent", async () => {
    expect(await repo.getByDate("2026-02-03")).toBeUndefined();

    const created = await repo.create("2026-02-03");
    const byDate = await repo.getByDate("2026-02-03");
    expect(byDate).toBeDefined();
    expect(byDate!.id).toBe(created.id);
  });

  it("getOrCreateForDate: first call creates, second call returns the same edition", async () => {
    const first = await repo.getOrCreateForDate("2026-03-04");
    const second = await repo.getOrCreateForDate("2026-03-04");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("building");

    const rows = await db.selectFrom("editions").selectAll().execute();
    expect(rows.length).toBe(1);
  });

  it("getOrCreateForDate concurrency: parallel calls resolve to the same id with exactly one row", async () => {
    const [a, b] = await Promise.all([
      repo.getOrCreateForDate("2026-04-05"),
      repo.getOrCreateForDate("2026-04-05"),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe("building");

    const rows = await db.selectFrom("editions").selectAll().execute();
    expect(rows.length).toBe(1);
  });

  it("valid transitions building->ready->publishing->published set published_at", async () => {
    const created = await repo.create("2026-05-06");
    const ready = await repo.transition(created.id, "ready");
    expect(ready.status).toBe("ready");
    expect(ready.published_at).toBeNull();

    const publishing = await repo.transition(created.id, "publishing");
    expect(publishing.status).toBe("publishing");

    const published = await repo.transition(created.id, "published");
    expect(published.status).toBe("published");
    expect(published.published_at).toBeInstanceOf(Date);
  });

  it("invalid transitions throw InvalidEditionTransitionError naming the transition", async () => {
    const e1 = await repo.create("2026-06-07");
    await expect(repo.transition(e1.id, "published")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
    await expect(repo.transition(e1.id, "published")).rejects.toThrow(
      /building → published/,
    );

    const e2 = await repo.create("2026-06-08");
    await repo.transition(e2.id, "ready");
    await expect(repo.transition(e2.id, "building")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
    await expect(repo.transition(e2.id, "building")).rejects.toThrow(
      /ready → building/,
    );

    const e3 = await repo.create("2026-06-09");
    await repo.transition(e3.id, "ready");
    await repo.transition(e3.id, "publishing");
    await expect(repo.transition(e3.id, "ready")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
  });

  it("published immutability: any transition on a published edition throws and leaves it published", async () => {
    const created = await repo.create("2026-07-08");
    await repo.transition(created.id, "ready");
    await repo.transition(created.id, "publishing");
    await repo.transition(created.id, "published");

    await expect(repo.transition(created.id, "building")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
    await expect(repo.transition(created.id, "ready")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
    await expect(repo.transition(created.id, "failed")).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );

    const after = await repo.getById(created.id);
    expect(after!.status).toBe("published");
  });

  it("failed recovery: building->failed sets failed_at + failure_reason; failed->building resumes", async () => {
    const created = await repo.create("2026-08-09");
    const failed = await repo.transition(created.id, "failed", {
      failureReason: "boom",
    });
    expect(failed.status).toBe("failed");
    expect(failed.failed_at).toBeInstanceOf(Date);
    expect(failed.failure_reason).toBe("boom");

    const resumed = await repo.transition(created.id, "building");
    expect(resumed.status).toBe("building");
  });

  it("optimistic concurrency: a concurrent status flip causes EditionConcurrentUpdateError and does not change the row", async () => {
    const created = await repo.create("2026-09-10");

    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query(
        `SELECT id FROM ${schema}.editions WHERE id = $1 FOR UPDATE`,
        [created.id],
      );
      await held.query(
        `UPDATE ${schema}.editions SET status = 'failed' WHERE id = $1`,
        [created.id],
      );

      const transitionPromise = repo.transition(created.id, "ready");
      await new Promise((resolve) => setTimeout(resolve, 75));

      await held.query("COMMIT");

      await expect(transitionPromise).rejects.toBeInstanceOf(
        EditionConcurrentUpdateError,
      );

      const after = await repo.getById(created.id);
      expect(after!.status).toBe("failed");
    } finally {
      try {
        await held.query("ROLLBACK");
      } catch {
        // already committed
      }
      held.release();
    }
  });

  it("transition on a missing id throws EditionNotFoundError", async () => {
    const missing = randomUUID();
    await expect(repo.transition(missing, "ready")).rejects.toBeInstanceOf(
      EditionNotFoundError,
    );
  });

  it("list helper invariant: exactly the created editions exist after a clean run", async () => {
    await repo.create("2026-10-11");
    await repo.create("2026-10-12");
    const all = await db.selectFrom("editions").selectAll().execute();
    const editionRows = all as Edition[];
    expect(editionRows.length).toBe(2);
    expect(new Set(editionRows.map((r) => r.publication_date.toISOString())).size).toBe(2);
  });
});
