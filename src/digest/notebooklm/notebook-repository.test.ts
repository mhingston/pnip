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
  "../../database/migrations/027_add_notebook_podcast_partition.sql",
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

  it("enforces UNIQUE(edition_id, partition_key) idempotency on the master partition", async () => {
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

  it("defaults partition_key to 'master' when createForEdition omits partitionKey", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-14");
    const row = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-default-partition",
      title: "x",
      url: "https://notebooklm.example.com/x",
    });
    expect(row.partition_key).toBe("master");
  });

  it("persists the explicit partition_key when createForEdition supplies one", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-15");
    const row = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-youtube",
      title: "x",
      url: "https://notebooklm.example.com/x",
      partitionKey: "youtube",
    });
    expect(row.partition_key).toBe("youtube");
  });

  it("allow two notebooks in the same edition when their partition_keys differ", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-16");
    const masterRow = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-master",
      title: "Master",
      url: "https://notebooklm.example.com/master",
      partitionKey: "master",
    });
    const youtubeRow = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-youtube",
      title: "YouTube",
      url: "https://notebooklm.example.com/youtube",
      partitionKey: "youtube",
    });
    expect(masterRow.id).not.toBe(youtubeRow.id);
    expect(masterRow.partition_key).toBe("master");
    expect(youtubeRow.partition_key).toBe("youtube");
  });

  it("getByEditionAndPartition returns the row matching the partition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-17");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-master-2",
      title: "Master",
      url: "https://notebooklm.example.com/m",
      partitionKey: "master",
    });
    const youtube = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-youtube-2",
      title: "YouTube",
      url: "https://notebooklm.example.com/y",
      partitionKey: "youtube",
    });
    const got = await repo.getByEditionAndPartition(ed.id, "youtube");
    expect(got).toBeDefined();
    expect(got!.id).toBe(youtube.id);
    expect(got!.partition_key).toBe("youtube");
  });

  it("getByEditionAndPartition returns undefined when no notebook exists for the partition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-18");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-only-master",
      title: "Master",
      url: "https://notebooklm.example.com/m",
      partitionKey: "master",
    });
    const got = await repo.getByEditionAndPartition(ed.id, "youtube");
    expect(got).toBeUndefined();
  });

  it("getByEdition returns only the master partition row by default", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-19");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-m-3",
      title: "Master",
      url: "https://notebooklm.example.com/m",
      partitionKey: "master",
    });
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-y-3",
      title: "YouTube",
      url: "https://notebooklm.example.com/y",
      partitionKey: "youtube",
    });
    const got = await repo.getByEdition(ed.id);
    expect(got).toBeDefined();
    expect(got!.partition_key).toBe("master");
  });

  it("deleteByEditionAndPartition removes only the targeted partition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-20");
    const master = await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-m-4",
      title: "Master",
      url: "https://notebooklm.example.com/m",
      partitionKey: "master",
    });
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-y-4",
      title: "YouTube",
      url: "https://notebooklm.example.com/y",
      partitionKey: "youtube",
    });
    await repo.deleteByEditionAndPartition(ed.id, "youtube");
    expect(await repo.getByEditionAndPartition(ed.id, "youtube")).toBeUndefined();
    const masterAfter = await repo.getByEditionAndPartition(ed.id, "master");
    expect(masterAfter).toBeDefined();
    expect(masterAfter!.id).toBe(master.id);
  });

  it("createForEdition with partitionKey=other throws NotebookConflictError on a duplicate (other partition, not master)", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-21");
    await repo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-y-first",
      title: "YouTube",
      url: "https://notebooklm.example.com/y",
      partitionKey: "youtube",
    });
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        notebookExternalId: "nb-y-second",
        title: "YouTube 2",
        url: "https://notebooklm.example.com/y2",
        partitionKey: "youtube",
      }),
    ).rejects.toBeInstanceOf(NotebookConflictError);
  });

  it("NotebookConflictError includes partitionKey field and is named NotebookConflictError", async () => {
    const err = new NotebookConflictError("ed-xyz", "reddit");
    expect(err.name).toBe("NotebookConflictError");
    expect(err.editionId).toBe("ed-xyz");
    expect(err.partitionKey).toBe("reddit");
    expect(err.message).toContain("ed-xyz");
    expect(err.message).toContain("reddit");
  });
});