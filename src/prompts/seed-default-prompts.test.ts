import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, CompiledQuery } from "kysely";
import { loadConfig } from "../config/index.js";
import { createPool, closePool, type PgPool } from "../database/pool.js";
import { closeKysely, type Database } from "../database/kysely.js";
import {
  createPromptRepository,
  type PromptRepository,
} from "./prompt-repository.js";
import {
  seedDefaultPrompts,
  DEFAULT_PROMPTS,
} from "./seed-default-prompts.js";

const promptMigrationPath = fileURLToPath(
  new URL("../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

describe("seedDefaultPrompts", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let promptRepo: PromptRepository;
  const schema = schemaName("seed_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set");
    pool = createPool(url);
    const promptSql = await readFile(promptMigrationPath, "utf8");

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(promptSql);
    } finally {
      client.release();
    }

    const kyselyPool = createPool(url);
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
    promptRepo = createPromptRepository(db);
  });

  afterAll(async () => {
    await closeKysely(db);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    await closePool(pool);
  });

  beforeEach(async () => {
    await db.deleteFrom("prompt_versions").execute();
  });

  it("creates all 5 default prompts on first run", async () => {
    const summary = await seedDefaultPrompts(promptRepo);
    expect(summary.created).toBe(5);
    expect(summary.skipped).toBe(0);
    expect(summary.results.map((r) => r.name).sort()).toEqual(
      ["entities", "quality", "story_summary", "summary", "topics"],
    );

    for (const def of DEFAULT_PROMPTS) {
      const latest = await promptRepo.getLatestVersion(def.name);
      expect(latest).toBeDefined();
      expect(latest!.version).toBe(1);
      expect(latest!.template).toBe(def.template);
    }
  });

  it("is idempotent: second run skips all", async () => {
    await seedDefaultPrompts(promptRepo);
    const second = await seedDefaultPrompts(promptRepo);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(5);
    for (const r of second.results) {
      expect(r.status).toBe("skipped");
      expect(r.version).toBe(1);
    }

    const all = await promptRepo.listByName("summary");
    expect(all).toHaveLength(1);
  });

  it("only seeds missing prompts (partial seed)", async () => {
    await promptRepo.createNewVersion({
      name: "summary",
      template: "custom",
      purpose: "custom",
    });

    const summary = await seedDefaultPrompts(promptRepo);
    expect(summary.created).toBe(4);
    expect(summary.skipped).toBe(1);
    const skipped = summary.results.find((r) => r.name === "summary");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.version).toBe(1);

    const latest = await promptRepo.getLatestVersion("summary");
    expect(latest?.template).toBe("custom");
  });

  it("does not increment version of already-seeded prompt", async () => {
    await seedDefaultPrompts(promptRepo);
    const before = await promptRepo.getLatestVersion("summary");
    expect(before?.version).toBe(1);

    await seedDefaultPrompts(promptRepo);
    const after = await promptRepo.getLatestVersion("summary");
    expect(after?.version).toBe(1);
    expect(after?.id).toBe(before?.id);
  });
});
