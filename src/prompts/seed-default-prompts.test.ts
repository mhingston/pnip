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

  it("creates all 6 default prompt versions on first run (5 names + story_summary v2)", async () => {
    const summary = await seedDefaultPrompts(promptRepo);
    expect(summary.created).toBe(6);
    expect(summary.skipped).toBe(0);
    expect(summary.results.map((r) => `${r.name}@v${r.version}`).sort()).toEqual(
      [
        "entities@v1",
        "quality@v1",
        "story_summary@v1",
        "story_summary@v2",
        "summary@v1",
        "topics@v1",
      ],
    );

    for (const def of DEFAULT_PROMPTS) {
      const version = def.version ?? 1;
      const row = await promptRepo.getByNameAndVersion(def.name, version);
      expect(row).toBeDefined();
      expect(row!.template).toBe(def.template);
    }
  });

  it("is idempotent: second run skips all", async () => {
    await seedDefaultPrompts(promptRepo);
    const second = await seedDefaultPrompts(promptRepo);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(6);

    const all = await promptRepo.listByName("story_summary");
    expect(all).toHaveLength(2);
  });

  it("only seeds missing prompts (partial seed)", async () => {
    await promptRepo.createNewVersion({
      name: "summary",
      template: "custom",
      purpose: "custom",
    });

    const summary = await seedDefaultPrompts(promptRepo);
    expect(summary.created).toBe(5);
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

  it("preserves user-customized v1 of story_summary while seeding the new v2 default", async () => {
    await promptRepo.createNewVersion({
      name: "story_summary",
      template: "custom-v1",
      purpose: "custom-v1",
    });

    const summary = await seedDefaultPrompts(promptRepo);
    const storyResults = summary.results.filter(
      (r) => r.name === "story_summary",
    );
    expect(storyResults.find((r) => r.version === 1)?.status).toBe("skipped");
    expect(storyResults.find((r) => r.version === 2)?.status).toBe("created");

    const v1 = await promptRepo.getByNameAndVersion("story_summary", 1);
    const v2 = await promptRepo.getByNameAndVersion("story_summary", 2);
    expect(v1?.template).toBe("custom-v1");
    expect(v2?.template.toLowerCase()).toContain("abstractive");
  });

  it("new v2 story_summary requires claims to add information not in the summary", async () => {
    const v2 = DEFAULT_PROMPTS.find(
      (d) => d.name === "story_summary" && d.version === 2,
    );
    expect(v2).toBeDefined();
    expect(v2!.template.toLowerCase()).toContain("abstractive");
    expect(v2!.template).toContain("NOT already in the summary");
    expect(v2!.template).toContain("DO NOT include claims");
    expect(v2!.template).not.toContain("extracted from the summary");
  });
});