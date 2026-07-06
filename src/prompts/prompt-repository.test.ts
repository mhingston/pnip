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
  type PromptVersion,
} from "../database/kysely.js";
import {
  createPromptRepository,
  PromptVersionConflictError,
  type PromptRepository,
} from "./prompt-repository.js";

const migrationSqlPath = fileURLToPath(
  new URL("../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("PromptRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: PromptRepository;
  const schema = schemaName("prompt_test_");

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
    repo = createPromptRepository(db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.prompt_versions`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  it("create + getByNameAndVersion: creates a prompt version and fetches it back", async () => {
    const created = await repo.create({
      name: "summary",
      version: 1,
      template: "Summarize: {{input}}",
      purpose: "summary",
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("summary");
    expect(created.version).toBe(1);
    expect(created.template).toBe("Summarize: {{input}}");
    expect(created.purpose).toBe("summary");
    expect(created.created_at).toBeInstanceOf(Date);

    const byNameVersion = await repo.getByNameAndVersion("summary", 1);
    expect(byNameVersion).toBeDefined();
    expect(byNameVersion!.id).toBe(created.id);
    expect(byNameVersion!.template).toBe("Summarize: {{input}}");

    const byId = await repo.getById(created.id);
    expect(byId).toBeDefined();
    expect(byId!.id).toBe(created.id);
    expect(byId!.name).toBe("summary");
  });

  it("duplicate (name, version) throws PromptVersionConflictError", async () => {
    await repo.create({
      name: "dedupe",
      version: 1,
      template: "v1",
      purpose: "test",
    });
    await expect(
      repo.create({
        name: "dedupe",
        version: 1,
        template: "v1-again",
        purpose: "test",
      }),
    ).rejects.toBeInstanceOf(PromptVersionConflictError);
    await expect(
      repo.create({
        name: "dedupe",
        version: 1,
        template: "v1-again",
        purpose: "test",
      }),
    ).rejects.toThrow(/dedupe.*1/);
  });

  it("getLatestVersion returns the highest version even when inserted out of order", async () => {
    await repo.create({ name: "ordered", version: 1, template: "t1", purpose: "p" });
    await repo.create({ name: "ordered", version: 3, template: "t3", purpose: "p" });
    await repo.create({ name: "ordered", version: 2, template: "t2", purpose: "p" });

    const latest = await repo.getLatestVersion("ordered");
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(3);
    expect(latest!.template).toBe("t3");
  });

  it("getLatestVersion returns undefined for an unknown name", async () => {
    expect(await repo.getLatestVersion("does-not-exist")).toBeUndefined();
  });

  it("createNewVersion on a brand-new name creates version 1", async () => {
    const created = await repo.createNewVersion({
      name: "fresh",
      template: "first",
      purpose: "p",
    });
    expect(created.version).toBe(1);
    expect(created.name).toBe("fresh");
    expect(created.template).toBe("first");

    const latest = await repo.getLatestVersion("fresh");
    expect(latest!.version).toBe(1);
  });

  it("createNewVersion increments above an existing version", async () => {
    await repo.create({ name: "incr", version: 1, template: "t1", purpose: "p" });

    const v2 = await repo.createNewVersion({ name: "incr", template: "t2", purpose: "p" });
    expect(v2.version).toBe(2);

    const v3 = await repo.createNewVersion({ name: "incr", template: "t3", purpose: "p" });
    expect(v3.version).toBe(3);

    const latest = await repo.getLatestVersion("incr");
    expect(latest!.version).toBe(3);
  });

  it("listByName returns all versions for a name ordered by version DESC", async () => {
    await repo.create({ name: "listme", version: 1, template: "t1", purpose: "p" });
    await repo.create({ name: "listme", version: 3, template: "t3", purpose: "p" });
    await repo.create({ name: "listme", version: 2, template: "t2", purpose: "p" });

    const list = await repo.listByName("listme");
    expect(list.map((r) => r.version)).toEqual([3, 2, 1]);
  });

  it("concurrency: parallel createNewVersion produce distinct sequential versions", async () => {
    const [a, b] = await Promise.all([
      repo.createNewVersion({ name: "concurrent", template: "a", purpose: "p" }),
      repo.createNewVersion({ name: "concurrent", template: "b", purpose: "p" }),
    ]);

    const versions = new Set([a.version, b.version]);
    expect(versions.size).toBe(2);
    expect(versions.has(1)).toBe(true);
    expect(versions.has(2)).toBe(true);

    const rows = await repo.listByName("concurrent");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.version).sort((x, y) => x - y)).toEqual([1, 2]);
  });

  it("immutability: no update/delete/save/upsert methods exposed", async () => {
    const anyRepo = repo as unknown as Record<string, unknown>;
    expect(anyRepo.update).toBeUndefined();
    expect(anyRepo.delete).toBeUndefined();
    expect(anyRepo.save).toBeUndefined();
    expect(anyRepo.upsert).toBeUndefined();
    expect(anyRepo.remove).toBeUndefined();
  });

  it("list helper invariant: only created rows exist after a clean run", async () => {
    await repo.create({ name: "inv", version: 1, template: "t1", purpose: "p" });
    await repo.create({ name: "inv", version: 2, template: "t2", purpose: "p" });
    const all = await db.selectFrom("prompt_versions").selectAll().execute();
    const promptRows = all as PromptVersion[];
    expect(promptRows.length).toBe(2);
    expect(new Set(promptRows.map((r) => r.version)).size).toBe(2);
  });
});
