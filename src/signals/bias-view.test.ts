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
import { closeKysely, type Database } from "../database/kysely.js";
import { createEditionRepository } from "../editions/edition-repository.js";
import {
  createSignalRepository,
  type CreateSignalInput,
} from "./signal-repository.js";
import { getBiasView } from "./bias-view.js";

const migrationSqlPaths = [
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/004_create_prompt_versions.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/009_create_document_sections.sql",
  "../database/migrations/010_create_document_chunks.sql",
  "../database/migrations/017_create_story_clusters.sql",
  "../database/migrations/024_create_signals.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("getBiasView", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("biasview_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set");
    pool = createPool(url);
    const kyselyPool = createPool(url);

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const rel of migrationSqlPaths) {
        const sqlText = await readMigrationSql(rel);
        await client.query(sqlText);
      }
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
  });

  afterAll(async () => {
    if (db) await closeKysely(db);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    await closePool(pool);
  });

  beforeEach(async () => {
    await db.deleteFrom("signals").execute();
    await db.deleteFrom("story_clusters").execute();
    await db.deleteFrom("editions").execute();
  });

  async function createEdition(publicationDate: string): Promise<string> {
    const editionRepo = createEditionRepository(db);
    const ed = await editionRepo.create(publicationDate);
    return ed.id;
  }

  async function createStory(editionId: string, label: string): Promise<string> {
    const row = await db
      .insertInto("story_clusters")
      .values({
        edition_id: editionId,
        label,
        cluster_order: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  }

  function signal(
    editionId: string,
    kind: string,
    overrides: Partial<CreateSignalInput> = {},
  ): CreateSignalInput {
    return { signal_kind: kind, edition_id: editionId, ...overrides };
  }

  it("returns an empty bias view when there are no signals", async () => {
    const editionId = await createEdition("2026-07-08");
    const view = await getBiasView(db, editionId);
    expect(view.storyBias.size).toBe(0);
    expect(view.sourceBias.size).toBe(0);
    expect(view.mutedSourceIdentities.size).toBe(0);
  });

  it("aggregates story_up signals into positive up_votes and net_score", async () => {
    const editionId = await createEdition("2026-07-08");
    const storyId = await createStory(editionId, "AI story");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      signal(editionId, "story_up", { story_id: storyId }),
      signal(editionId, "story_up", { story_id: storyId }),
      signal(editionId, "story_up", { story_id: storyId }),
    ]);
    const view = await getBiasView(db, editionId);
    expect(view.storyBias.size).toBe(1);
    const entry = view.storyBias.get(storyId);
    expect(entry).toBeDefined();
    expect(entry!.up_votes).toBe(3);
    expect(entry!.down_votes).toBe(0);
    expect(entry!.net_score).toBe(3);
    expect(view.sourceBias.size).toBe(0);
  });

  it("aggregates story_down signals into negative net_score", async () => {
    const editionId = await createEdition("2026-07-08");
    const storyId = await createStory(editionId, "Bad story");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      signal(editionId, "story_down", { story_id: storyId }),
      signal(editionId, "story_down", { story_id: storyId }),
    ]);
    const view = await getBiasView(db, editionId);
    const entry = view.storyBias.get(storyId);
    expect(entry!.up_votes).toBe(0);
    expect(entry!.down_votes).toBe(2);
    expect(entry!.net_score).toBe(-2);
  });

  it("combines mixed story_up and story_down into net_score = up - down", async () => {
    const editionId = await createEdition("2026-07-08");
    const storyA = await createStory(editionId, "Story A");
    const storyB = await createStory(editionId, "Story B");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      signal(editionId, "story_up", { story_id: storyA }),
      signal(editionId, "story_up", { story_id: storyA }),
      signal(editionId, "story_down", { story_id: storyA }),
      signal(editionId, "story_down", { story_id: storyB }),
      signal(editionId, "story_down", { story_id: storyB }),
      signal(editionId, "story_down", { story_id: storyB }),
      signal(editionId, "story_down", { story_id: storyB }),
    ]);
    const view = await getBiasView(db, editionId);
    expect(view.storyBias.size).toBe(2);
    expect(view.storyBias.get(storyA)!.net_score).toBe(1);
    expect(view.storyBias.get(storyB)!.net_score).toBe(-4);
  });

  it("aggregates source_muted signals into the sourceBias map and muted set", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      signal(editionId, "source_muted", { source_identity: "theverge.com" }),
      signal(editionId, "source_muted", { source_identity: "theverge.com" }),
      signal(editionId, "source_muted", { source_identity: "techcrunch.com" }),
    ]);
    const view = await getBiasView(db, editionId);
    expect(view.sourceBias.size).toBe(2);
    const verge = view.sourceBias.get("theverge.com");
    expect(verge).toBeDefined();
    expect(verge!.muted).toBe(true);
    expect(verge!.mute_count).toBe(2);
    expect(view.sourceBias.get("techcrunch.com")!.mute_count).toBe(1);
    expect(view.mutedSourceIdentities.has("theverge.com")).toBe(true);
    expect(view.mutedSourceIdentities.has("techcrunch.com")).toBe(true);
    expect(view.mutedSourceIdentities.size).toBe(2);
    expect(view.storyBias.size).toBe(0);
  });

  it("is scoped to the requested edition and ignores other editions' signals", async () => {
    const ed1 = await createEdition("2026-07-08");
    const ed2 = await createEdition("2026-07-09");
    const story1 = await createStory(ed1, "Story 1");
    const story2 = await createStory(ed2, "Story 2");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      signal(ed1, "story_up", { story_id: story1 }),
      signal(ed1, "source_muted", { source_identity: "theverge.com" }),
      signal(ed2, "story_down", { story_id: story2 }),
      signal(ed2, "source_muted", { source_identity: "techcrunch.com" }),
    ]);
    const view = await getBiasView(db, ed1);
    expect(view.storyBias.size).toBe(1);
    expect(view.storyBias.has(story1)).toBe(true);
    expect(view.storyBias.has(story2)).toBe(false);
    expect(view.sourceBias.size).toBe(1);
    expect(view.mutedSourceIdentities.has("theverge.com")).toBe(true);
    expect(view.mutedSourceIdentities.has("techcrunch.com")).toBe(false);
  });
});
