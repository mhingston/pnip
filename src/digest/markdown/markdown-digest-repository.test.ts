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
import { loadConfig } from "../../config/index.js";
import { createPool, closePool, type PgPool } from "../../database/pool.js";
import { closeKysely, type Database } from "../../database/kysely.js";
import { createEditionRepository } from "../../editions/edition-repository.js";
import {
  createMarkdownDigestRepository,
  MarkdownDigestConflictError,
} from "./markdown-digest-repository.js";

const migrationSqlPaths = [
  "../../database/migrations/003_create_editions.sql",
  "../../database/migrations/020_create_markdown_digests.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("MarkdownDigestRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("mdrepo_");

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
    await db.deleteFrom("markdown_digests").execute();
    await db.deleteFrom("editions").execute();
  });

  it("persists a markdown digest for an edition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createMarkdownDigestRepository(db);
    const ed = await editionRepo.create("2026-07-07");
    const row = await repo.createForEdition({
      editionId: ed.id,
      content: "# Hello",
      storyCount: 1,
      documentCount: 2,
      citationCount: 3,
    });
    expect(row.edition_id).toBe(ed.id);
    expect(row.content).toBe("# Hello");
    expect(row.story_count).toBe(1);
    expect(row.document_count).toBe(2);
    expect(row.citation_count).toBe(3);
  });

  it("enforces UNIQUE(edition_id) idempotency", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createMarkdownDigestRepository(db);
    const ed = await editionRepo.create("2026-07-08");
    await repo.createForEdition({
      editionId: ed.id,
      content: "first",
      storyCount: 0,
      documentCount: 0,
      citationCount: 0,
    });
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        content: "second",
        storyCount: 0,
        documentCount: 0,
        citationCount: 0,
      }),
    ).rejects.toBeInstanceOf(MarkdownDigestConflictError);
  });

  it("getByEdition returns the only row for the edition or undefined", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createMarkdownDigestRepository(db);
    const ed = await editionRepo.create("2026-07-09");
    await repo.createForEdition({
      editionId: ed.id,
      content: "x",
      storyCount: 1,
      documentCount: 1,
      citationCount: 0,
    });
    const got = await repo.getByEdition(ed.id);
    expect(got).toBeDefined();
    expect(got!.content).toBe("x");
    const missing = await repo.getByEdition("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeUndefined();
  });

  it("deleteByEdition removes the row for the edition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createMarkdownDigestRepository(db);
    const ed = await editionRepo.create("2026-07-10");
    await repo.createForEdition({
      editionId: ed.id,
      content: "x",
      storyCount: 0,
      documentCount: 0,
      citationCount: 0,
    });
    await repo.deleteByEdition(ed.id);
    const got = await repo.getByEdition(ed.id);
    expect(got).toBeUndefined();
  });
});
