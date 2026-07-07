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
import {
  createDocumentRepository,
  type DocumentRepository,
} from "../expansion/document-repository.js";
import {
  createStoryRepository,
  type StoryRepository,
} from "./story-repository.js";

const editionMigrationPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const docMigrationPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);
const sectionMigrationPath = fileURLToPath(
  new URL("../database/migrations/009_create_document_sections.sql", import.meta.url),
);
const chunkMigrationPath = fileURLToPath(
  new URL("../database/migrations/010_create_document_chunks.sql", import.meta.url),
);
const promptMigrationPath = fileURLToPath(
  new URL("../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);
const storyMigrationPath = fileURLToPath(
  new URL(
    "../database/migrations/017_create_story_clusters.sql",
    import.meta.url,
  ),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("StoryRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  let docRepo: DocumentRepository;
  let storyRepo: StoryRepository;
  const schema = schemaName("story_");
  let editionId: string;
  let doc1: string;
  let doc2: string;
  let doc3: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const editionSql = await readFile(editionMigrationPath, "utf8");
    const docSql = await readFile(docMigrationPath, "utf8");
    const sectionSql = await readFile(sectionMigrationPath, "utf8");
    const chunkSql = await readFile(chunkMigrationPath, "utf8");
    const promptSql = await readFile(promptMigrationPath, "utf8");
    const storySql = await readFile(storyMigrationPath, "utf8");

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(sectionSql);
      await client.query(chunkSql);
      await client.query(promptSql);
      await client.query(storySql);
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
    docRepo = createDocumentRepository(db);
    storyRepo = createStoryRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-07-01") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;

    const d1 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/story-1",
    });
    const d2 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/story-2",
    });
    const d3 = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/story-3",
    });
    doc1 = d1.id;
    doc2 = d2.id;
    doc3 = d3.id;
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
    await db.deleteFrom("cluster_members").execute();
    await db.deleteFrom("story_clusters").execute();
  });

  it("replaces stories for an edition atomically", async () => {
    const first = await storyRepo.replaceForEdition({
      editionId,
      stories: [
        { label: "story-a", documentIds: [doc1, doc2] },
        { label: "story-b", documentIds: [doc3] },
      ],
    });
    expect(first.stories).toHaveLength(2);
    expect(first.removedStoryIds).toHaveLength(0);

    const all = await storyRepo.getByEdition(editionId);
    expect(all).toHaveLength(2);
    expect(all[0].story.label).toBe("story-a");
    expect(all[0].members).toHaveLength(2);
    expect(all[1].story.label).toBe("story-b");
    expect(all[1].members).toHaveLength(1);
  });

  it("re-running replaceForEdition removes previous stories for the edition", async () => {
    await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "old", documentIds: [doc1, doc2, doc3] }],
    });

    const second = await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "new", documentIds: [doc1] }],
    });
    expect(second.stories).toHaveLength(1);
    expect(second.removedStoryIds).toHaveLength(1);

    const all = await storyRepo.getByEdition(editionId);
    expect(all).toHaveLength(1);
    expect(all[0].story.label).toBe("new");
    expect(all[0].members.map((m) => m.document_id)).toEqual([doc1]);
  });

  it("cluster member uniqueness within a story: same document twice in one story raises", async () => {
    await expect(
      storyRepo.replaceForEdition({
        editionId,
        stories: [{ label: "a", documentIds: [doc1, doc1] }],
      }),
    ).rejects.toThrow();
  });

  it("getStoryForDocument returns the story containing the document", async () => {
    await storyRepo.replaceForEdition({
      editionId,
      stories: [
        { label: "a", documentIds: [doc1, doc2] },
        { label: "b", documentIds: [doc3] },
      ],
    });

    const a = await storyRepo.getStoryForDocument(doc1);
    expect(a).toBeDefined();
    expect(a!.label).toBe("a");

    const b = await storyRepo.getStoryForDocument(doc3);
    expect(b).toBeDefined();
    expect(b!.label).toBe("b");
  });

  it("similarity scores are persisted on cluster members", async () => {
    await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "a", documentIds: [doc1, doc2] }],
    });

    const fallback = new Map<string, number>([[doc1, 0.91]]);

    await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "a", documentIds: [doc1, doc2] }],
      similarities: fallback,
    });

    const all = await storyRepo.getByEdition(editionId);
    const members = all[0].members;
    const m1 = members.find((m) => m.document_id === doc1);
    expect(m1?.similarity).toBeCloseTo(0.91);
  });

  it("deleteByEdition removes all stories and members for an edition", async () => {
    await storyRepo.replaceForEdition({
      editionId,
      stories: [
        { label: "a", documentIds: [doc1] },
        { label: "b", documentIds: [doc2] },
      ],
    });

    await storyRepo.deleteByEdition(editionId);
    const all = await storyRepo.getByEdition(editionId);
    expect(all).toHaveLength(0);
  });
});
