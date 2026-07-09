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
  type NotebookRow,
} from "./notebook-repository.js";
import {
  createPodcastRepository,
  PodcastConflictError,
} from "./podcast-repository.js";

const migrationSqlPaths = [
  "../../database/migrations/003_create_editions.sql",
  "../../database/migrations/022_create_notebooks.sql",
  "../../database/migrations/023_create_podcasts.sql",
  "../../database/migrations/027_add_notebook_podcast_partition.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("PodcastRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("pcrepo_");

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
    await db.deleteFrom("podcasts").execute();
    await db.deleteFrom("notebooks").execute();
    await db.deleteFrom("editions").execute();
  });

  async function createNotebookFixture(): Promise<{
    editionId: string;
    notebook: NotebookRow;
  }> {
    const editionRepo = createEditionRepository(db);
    const notebookRepo = createNotebookRepository(db);
    const ed = await editionRepo.create("2026-07-07");
    const nb = await notebookRepo.createForEdition({
      editionId: ed.id,
      notebookExternalId: `nb-${randomUUID()}`,
      title: "Fixture Notebook",
      url: "https://notebooklm.example.com/fixture",
    });
    return { editionId: ed.id, notebook: nb };
  }

  it("persists a podcast with minimal inputs and sensible defaults", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const row = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    expect(row.edition_id).toBe(editionId);
    expect(row.notebook_id).toBe(notebook.id);
    expect(row.artifact_external_id).toBe("artifact-1");
    expect(row.status).toBe("pending");
    expect(row.url).toBeNull();
    expect(row.title).toBeNull();
    expect(row.duration_seconds).toBeNull();
    expect(row.format).toBeNull();
    expect(row.language).toBeNull();
    expect(row.local_path).toBeNull();
    expect(row.provider_response).toBeNull();
    expect(row.failure_reason).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.id).toBeDefined();
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it("persists all provided fields including title, format, language, started_at, and provider_response", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const startedAt = new Date("2026-07-07T09:00:00Z");
    const response = { taskId: "abc" };
    const row = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-2",
      title: "Episode 1",
      format: "mp3",
      language: "en",
      status: "generating",
      startedAt,
      providerResponse: response,
    });
    expect(row.title).toBe("Episode 1");
    expect(row.format).toBe("mp3");
    expect(row.language).toBe("en");
    expect(row.status).toBe("generating");
    expect(row.started_at).toBeInstanceOf(Date);
    expect((row.started_at as Date).toISOString()).toBe(
      "2026-07-07T09:00:00.000Z",
    );
    expect(row.provider_response).toEqual(response);
  });

  it("enforces UNIQUE(edition_id, partition_key) idempotency on the master partition", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    await expect(
      repo.createForEdition({
        editionId,
        notebookId: notebook.id,
        artifactExternalId: "artifact-2",
      }),
    ).rejects.toBeInstanceOf(PodcastConflictError);
  });

  it("enforces the notebook_id foreign key to notebooks", async () => {
    const repo = createPodcastRepository(db);
    const editionRepo = createEditionRepository(db);
    const ed = await editionRepo.create("2026-07-08");
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        notebookId: "00000000-0000-0000-0000-000000000000",
        artifactExternalId: "artifact-orphan",
      }),
    ).rejects.toThrow();
  });

  it("getByEdition returns the row or undefined", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    const got = await repo.getByEdition(editionId);
    expect(got).toBeDefined();
    expect(got!.artifact_external_id).toBe("artifact-1");
    const missing = await repo.getByEdition(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(missing).toBeUndefined();
  });

  it("getById returns the row or undefined", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const created = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    const got = await repo.getById(created.id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(created.id);
    const missing = await repo.getById("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeUndefined();
  });

  it("getByArtifactExternalId returns the row or undefined", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-uniq",
    });
    const got = await repo.getByArtifactExternalId("artifact-uniq");
    expect(got).toBeDefined();
    expect(got!.artifact_external_id).toBe("artifact-uniq");
    const missing = await repo.getByArtifactExternalId("does-not-exist");
    expect(missing).toBeUndefined();
  });

  it("updateDelivery sets url, duration, status, and completedAt", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const created = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    const completedAt = new Date("2026-07-08T11:30:00Z");
    const updated = await repo.updateDelivery(created.id, {
      status: "ready",
      url: "https://cdn.example.com/podcast.mp3",
      durationSeconds: 1234,
      completedAt,
    });
    expect(updated.status).toBe("ready");
    expect(updated.url).toBe("https://cdn.example.com/podcast.mp3");
    expect(updated.duration_seconds).toBe(1234);
    expect(updated.completed_at).toBeInstanceOf(Date);
    expect((updated.completed_at as Date).toISOString()).toBe(
      "2026-07-08T11:30:00.000Z",
    );
  });

  it("updateDelivery is a partial update — fields not provided are left untouched", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const created = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
      title: "Original",
    });
    const onlyStatus = await repo.updateDelivery(created.id, {
      status: "failed",
    });
    expect(onlyStatus.status).toBe("failed");
    expect(onlyStatus.title).toBe("Original");
    expect(onlyStatus.url).toBeNull();
    expect(onlyStatus.duration_seconds).toBeNull();
    expect(onlyStatus.completed_at).toBeNull();
  });

  it("deleteByEdition removes the row", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-1",
    });
    await repo.deleteByEdition(editionId);
    expect(await repo.getByEdition(editionId)).toBeUndefined();
  });

  it("defaults partition_key to 'master' when createForEdition omits partitionKey", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const row = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-default-partition",
    });
    expect(row.partition_key).toBe("master");
  });

  it("getByNotebookId returns the podcast linked to that notebook", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const created = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-by-notebook",
    });
    const got = await repo.getByNotebookId(notebook.id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(created.id);
    expect(got!.notebook_id).toBe(notebook.id);
  });

  it("getByNotebookId returns undefined when no podcast exists for the notebook", async () => {
    const repo = createPodcastRepository(db);
    const got = await repo.getByNotebookId(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(got).toBeUndefined();
  });

  it("deleteByNotebookId removes the podcast linked to that notebook", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-delete-me",
    });
    await repo.deleteByNotebookId(notebook.id);
    expect(await repo.getByNotebookId(notebook.id)).toBeUndefined();
  });

  it("getByEdition returns only the master partition row by default", async () => {
    const repo = createPodcastRepository(db);
    const { editionId, notebook } = await createNotebookFixture();
    const masterPodcast = await repo.createForEdition({
      editionId,
      notebookId: notebook.id,
      artifactExternalId: "artifact-master",
      partitionKey: "master",
    });
    expect(masterPodcast.partition_key).toBe("master");
    const got = await repo.getByEdition(editionId);
    expect(got).toBeDefined();
    expect(got!.id).toBe(masterPodcast.id);
    expect(got!.partition_key).toBe("master");
  });

  it("createForEdition with partitionKey=other throws PodcastConflictError on a duplicate (other partition)", async () => {
    const editionRepo = createEditionRepository(db);
    const notebookRepo = createNotebookRepository(db);
    const repo = createPodcastRepository(db);
    const ed = await editionRepo.create("2026-07-09");
    const nb = await notebookRepo.createForEdition({
      editionId: ed.id,
      notebookExternalId: "nb-per-part",
      title: "x",
      url: "https://notebooklm.example.com/x",
      partitionKey: "youtube",
    });
    await repo.createForEdition({
      editionId: ed.id,
      notebookId: nb.id,
      artifactExternalId: "artifact-y-1",
      partitionKey: "youtube",
    });
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        notebookId: nb.id,
        artifactExternalId: "artifact-y-2",
        partitionKey: "youtube",
      }),
    ).rejects.toBeInstanceOf(PodcastConflictError);
  });

  it("PodcastConflictError includes partitionKey field and is named PodcastConflictError", async () => {
    const err = new PodcastConflictError("ed-xyz", "reddit");
    expect(err.name).toBe("PodcastConflictError");
    expect(err.editionId).toBe("ed-xyz");
    expect(err.partitionKey).toBe("reddit");
    expect(err.message).toContain("ed-xyz");
    expect(err.message).toContain("reddit");
  });
});