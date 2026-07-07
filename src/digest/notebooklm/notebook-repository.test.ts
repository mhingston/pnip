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
  createNotebookRepository,
  NotebookConflictError,
  type NotebookRow,
} from "./notebook-repository.js";

const migrationSqlPaths = [
  "../../database/migrations/003_create_editions.sql",
  "../../database/migrations/022_create_notebooks.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("NotebookRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("nbrepo_");

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
    await db.deleteFrom("notebooks").execute();
    await db.deleteFrom("editions").execute();
  });

  it("persists a notebook for an edition with sensible defaults", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-07");
    const row = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "My Notebook",
      url: "https://notebooklm.example.com/nb-1",
    });
    expect(row.edition_id).toBe(ed.id);
    expect(row.notebook_external_id).toBe("nb-ext-1");
    expect(row.title).toBe("My Notebook");
    expect(row.url).toBe("https://notebooklm.example.com/nb-1");
    expect(row.status).toBe("pending");
    expect(row.source_count).toBe(0);
    expect(row.provider_response).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.id).toBeDefined();
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it("persists all provided fields including status, source_count, and provider_response", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-07");
    const response = { notebookId: "nb-1", status: "queued" };
    const row = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-2",
      title: "Other",
      url: "https://notebooklm.example.com/nb-2",
      status: "ready",
      sourceCount: 5,
      providerResponse: response,
    });
    expect(row.status).toBe("ready");
    expect(row.source_count).toBe(5);
    expect(row.provider_response).toEqual(response);
  });

  it("enforces UNIQUE(edition_id) idempotency", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-08");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "first",
      url: "https://notebooklm.example.com/1",
    });
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        notebookExternalId: "nb-ext-2",
        title: "second",
        url: "https://notebooklm.example.com/2",
      }),
    ).rejects.toBeInstanceOf(NotebookConflictError);
  });

  it("getByEdition returns the row or undefined", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-09");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "x",
      url: "https://notebooklm.example.com/x",
    });
    const got = await repo.getByEdition(ed.id);
    expect(got).toBeDefined();
    expect(got!.title).toBe("x");
    const missing = await repo.getByEdition(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(missing).toBeUndefined();
  });

  it("getById returns the row or undefined", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-10");
    const created = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "x",
      url: "https://notebooklm.example.com/x",
    });
    const got = await repo.getById(created.id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(created.id);
    const missing = await repo.getById(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(missing).toBeUndefined();
  });

  it("getByExternalId returns the row or undefined", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-11");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-unique",
      title: "x",
      url: "https://notebooklm.example.com/x",
    });
    const got = await repo.getByExternalId("nb-ext-unique");
    expect(got).toBeDefined();
    expect(got!.notebook_external_id).toBe("nb-ext-unique");
    const missing = await repo.getByExternalId("does-not-exist");
    expect(missing).toBeUndefined();
  });

  it("updateDelivery applies a partial update and returns the updated row", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-12");
    const created = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "x",
      url: "https://notebooklm.example.com/x",
      sourceCount: 1,
    });
    const updated: NotebookRow = await repo.updateDelivery(created.id, {
      status: "ready",
      completedAt: new Date("2026-07-12T10:00:00Z"),
    });
    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe("ready");
    expect(updated.source_count).toBe(1);
    expect(updated.completed_at).toBeInstanceOf(Date);
    expect((updated.completed_at as Date).toISOString()).toBe(
      "2026-07-12T10:00:00.000Z",
    );

    const onlyStatus = await repo.updateDelivery(created.id, {
      status: "failed",
    });
    expect(onlyStatus.status).toBe("failed");
    expect(onlyStatus.completed_at).toBeInstanceOf(Date);
    expect(onlyStatus.source_count).toBe(1);

    const cleared = await repo.updateDelivery(created.id, {
      completedAt: null,
    });
    expect(cleared.completed_at).toBeNull();

    const response = { ok: true };
    const withResponse = await repo.updateDelivery(created.id, {
      providerResponse: response,
    });
    expect(withResponse.provider_response).toEqual(response);
  });

  it("deleteByEdition removes the row", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-13");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-ext-1",
      title: "x",
      url: "https://notebooklm.example.com/x",
    });
    await repo.deleteByEdition(ed.id);
    expect(await repo.getByEdition(ed.id)).toBeUndefined();
  });
});