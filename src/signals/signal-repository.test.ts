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
import { createDocumentRepository } from "../expansion/document-repository.js";
import { createSectionRepository } from "../expansion/section-repository.js";
import { createChunkRepository } from "../chunking/chunk-repository.js";
import {
  createSignalRepository,
  type CreateSignalInput,
} from "./signal-repository.js";

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

describe("SignalRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("sigrepo_");

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

  async function createChunkForEdition(
    editionId: string,
    chunkId: string,
  ): Promise<void> {
    const docRepo = createDocumentRepository(db);
    const sectionRepo = createSectionRepository(db);
    const chunkRepo = createChunkRepository(db);
    const doc = await docRepo.create({
      editionId,
      sourceType: "article",
      sourceUrl: `https://example.com/${chunkId}`,
    });
    const section = await sectionRepo.createBatch([
      {
        documentId: doc.id,
        order: 0,
        type: "paragraph",
        contentMarkdown: "body",
        contentText: "body text",
        metadata: {},
      },
    ]);
    await chunkRepo.createBatch([
      {
        id: chunkId,
        documentId: doc.id,
        sectionId: section[0]!.id,
        sequence: 0,
        text: "body text",
        tokenCount: 2,
        startOffset: 0,
        endOffset: 9,
        paragraphStart: 0,
        paragraphEnd: 0,
      },
    ]);
  }

  async function setCreatedAt(id: string, hoursAgo: number): Promise<void> {
    await pool.query(
      `UPDATE ${schema}.signals SET created_at = now() - ($1 * interval '1 hour') WHERE id = $2`,
      [hoursAgo, id],
    );
  }

  function baseInput(editionId: string, kind: string): CreateSignalInput {
    return { signal_kind: kind, edition_id: editionId };
  }

  it("createBatch inserts rows and returns them with ids and timestamps", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    const rows = await repo.createBatch([
      {
        ...baseInput(editionId, "clustered_into_story"),
        payload: { cluster_order: 1, label: "AI" },
      },
      {
        ...baseInput(editionId, "claimed_in_top"),
        payload: { top_position: 1 },
      },
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.edition_id).toBe(editionId);
    }
    expect(rows[0].signal_kind).toBe("clustered_into_story");
    expect(rows[1].signal_kind).toBe("claimed_in_top");
    expect(rows[0].payload).toEqual({ cluster_order: 1, label: "AI" });
  });

  it("createBatch with an empty array returns [] without hitting the DB", async () => {
    const repo = createSignalRepository(db);
    const rows = await repo.createBatch([]);
    expect(rows).toEqual([]);
  });

  it("createBatch stores source_identity alongside source_url", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    const [row] = await repo.createBatch([
      {
        ...baseInput(editionId, "clustered_into_story"),
        source_url: "https://www.theverge.com/2024/1/15/ai",
        source_identity: "theverge.com",
      },
    ]);
    expect(row.source_url).toBe("https://www.theverge.com/2024/1/15/ai");
    expect(row.source_identity).toBe("theverge.com");
  });

  it("getByEdition returns signals ordered by created_at ASC", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    const inserted = await repo.createBatch([
      baseInput(editionId, "s1"),
      baseInput(editionId, "s2"),
      baseInput(editionId, "s3"),
    ]);
    await setCreatedAt(inserted[0].id, 1);
    await setCreatedAt(inserted[1].id, 2);
    await setCreatedAt(inserted[2].id, 3);
    const got = await repo.getByEdition(editionId);
    expect(got.map((r) => r.id)).toEqual([
      inserted[2].id,
      inserted[1].id,
      inserted[0].id,
    ]);
  });

  it("getByEditionAndKind filters by signal_kind", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      baseInput(editionId, "clustered_into_story"),
      baseInput(editionId, "claimed_in_top"),
      baseInput(editionId, "clustered_into_story"),
    ]);
    const got = await repo.getByEditionAndKind(
      editionId,
      "clustered_into_story",
    );
    expect(got).toHaveLength(2);
    expect(got.every((r) => r.signal_kind === "clustered_into_story")).toBe(
      true,
    );
  });

  it("countByEditionAndKind returns the count for the given kind", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      baseInput(editionId, "clustered_into_story"),
      baseInput(editionId, "claimed_in_top"),
      baseInput(editionId, "clustered_into_story"),
    ]);
    expect(
      await repo.countByEditionAndKind(editionId, "clustered_into_story"),
    ).toBe(2);
    expect(
      await repo.countByEditionAndKind(editionId, "claimed_in_top"),
    ).toBe(1);
    expect(
      await repo.countByEditionAndKind(editionId, "chunk_in_story"),
    ).toBe(0);
  });

  it("getBySourceIdentity returns signals across editions ordered by created_at DESC", async () => {
    const ed1 = await createEdition("2026-07-08");
    const ed2 = await createEdition("2026-07-09");
    const repo = createSignalRepository(db);
    const a = await repo.createBatch([
      {
        ...baseInput(ed1, "clustered_into_story"),
        source_identity: "theverge.com",
      },
    ]);
    const b = await repo.createBatch([
      {
        ...baseInput(ed2, "clustered_into_story"),
        source_identity: "theverge.com",
      },
    ]);
    await repo.createBatch([
      {
        ...baseInput(ed1, "clustered_into_story"),
        source_identity: "other.com",
      },
    ]);
    await setCreatedAt(a[0].id, 3);
    await setCreatedAt(b[0].id, 1);
    const got = await repo.getBySourceIdentity("theverge.com");
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.id)).toEqual([b[0].id, a[0].id]);
    expect(got.every((r) => r.source_identity === "theverge.com")).toBe(true);
  });

  it("ON DELETE CASCADE removes signals when the edition is deleted", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      baseInput(editionId, "clustered_into_story"),
      baseInput(editionId, "claimed_in_top"),
    ]);
    expect(
      await repo.countByEditionAndKind(editionId, "clustered_into_story"),
    ).toBe(1);
    await db.deleteFrom("editions").where("id", "=", editionId).execute();
    expect(await repo.getByEdition(editionId)).toEqual([]);
  });

  it("getFeedbackSummary aggregates signalCounts, totals, and top lists for an edition", async () => {
    const editionId = await createEdition("2026-07-08");
    const storyId = await createStory(editionId, "Test Story");
    await createChunkForEdition(editionId, "chunk-A");
    await createChunkForEdition(editionId, "chunk-B");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      {
        ...baseInput(editionId, "story_up"),
        story_id: storyId,
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "story_up"),
        story_id: storyId,
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "story_down"),
        story_id: storyId,
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "source_muted"),
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "source_muted"),
        source_identity: "reddit.com/r/ml",
      },
      {
        ...baseInput(editionId, "chunk_starred"),
        chunk_id: "chunk-A",
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "chunk_starred"),
        chunk_id: "chunk-A",
        source_identity: "theverge.com",
      },
      {
        ...baseInput(editionId, "chunk_starred"),
        chunk_id: "chunk-B",
        source_identity: "reddit.com/r/ml",
      },
    ]);

    const summary = await repo.getFeedbackSummary({
      editionId,
      limit: 10,
    });

    expect(summary.totalSignals).toBe(8);
    expect(summary.sourceIdentityCount).toBe(2);
    expect(summary.storyVoteCount).toBe(1);
    expect(summary.signalCounts).toEqual({
      story_up: 2,
      story_down: 1,
      source_muted: 2,
      chunk_starred: 3,
    });
    expect(summary.topMutedSources).toEqual([
      { source_identity: "reddit.com/r/ml", mute_count: 1 },
      { source_identity: "theverge.com", mute_count: 1 },
    ]);
    expect(summary.topVotedStories).toEqual([
      {
        story_id: storyId,
        net_score: 1,
        up: 2,
        down: 1,
      },
    ]);
    expect(summary.topStarredChunks).toEqual([
      { chunk_id: "chunk-A", star_count: 2 },
      { chunk_id: "chunk-B", star_count: 1 },
    ]);
  });

  it("getFeedbackSummary with editionId filter excludes signals from other editions", async () => {
    const edA = await createEdition("2026-07-08");
    const edB = await createEdition("2026-07-09");
    const storyA = await createStory(edA, "Story A");
    const storyB = await createStory(edB, "Story B");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      { ...baseInput(edA, "story_up"), story_id: storyA },
      { ...baseInput(edB, "story_up"), story_id: storyB },
      { ...baseInput(edB, "story_down"), story_id: storyB },
      { ...baseInput(edA, "source_muted"), source_identity: "theverge.com" },
      { ...baseInput(edB, "source_muted"), source_identity: "reddit.com" },
    ]);

    const aSummary = await repo.getFeedbackSummary({
      editionId: edA,
      limit: 10,
    });
    expect(aSummary.totalSignals).toBe(2);
    expect(aSummary.signalCounts).toEqual({
      story_up: 1,
      source_muted: 1,
    });
    expect(aSummary.sourceIdentityCount).toBe(1);
    expect(aSummary.storyVoteCount).toBe(1);
    expect(aSummary.topVotedStories).toEqual([
      {
        story_id: storyA,
        net_score: 1,
        up: 1,
        down: 0,
      },
    ]);
    expect(aSummary.topMutedSources).toEqual([
      { source_identity: "theverge.com", mute_count: 1 },
    ]);

    const bSummary = await repo.getFeedbackSummary({
      editionId: edB,
      limit: 10,
    });
    expect(bSummary.totalSignals).toBe(3);
    expect(bSummary.storyVoteCount).toBe(1);
    expect(bSummary.topVotedStories).toEqual([
      {
        story_id: storyB,
        net_score: 0,
        up: 1,
        down: 1,
      },
    ]);
  });

  it("getFeedbackSummary without editionId aggregates across all editions", async () => {
    const edA = await createEdition("2026-07-08");
    const edB = await createEdition("2026-07-09");
    const storyA = await createStory(edA, "Story A");
    const storyB = await createStory(edB, "Story B");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      { ...baseInput(edA, "story_up"), story_id: storyA },
      { ...baseInput(edB, "story_up"), story_id: storyB },
    ]);

    const summary = await repo.getFeedbackSummary({ limit: 10 });
    expect(summary.totalSignals).toBe(2);
    expect(summary.storyVoteCount).toBe(2);
    expect(summary.topVotedStories).toHaveLength(2);
  });

  it("getSourceIdentityStats returns counts for one source", async () => {
    const ed1 = await createEdition("2026-07-08");
    const ed2 = await createEdition("2026-07-09");
    const sharedStory = await createStory(ed1, "Shared Story");
    await createChunkForEdition(ed1, "c1");
    await createChunkForEdition(ed1, "c2");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      { ...baseInput(ed1, "source_muted"), source_identity: "theverge.com" },
      { ...baseInput(ed2, "source_muted"), source_identity: "theverge.com" },
      { ...baseInput(ed1, "chunk_starred"), chunk_id: "c1", source_identity: "theverge.com" },
      { ...baseInput(ed1, "story_up"), story_id: sharedStory, source_identity: "theverge.com" },
      { ...baseInput(ed2, "story_down"), story_id: sharedStory, source_identity: "theverge.com" },
      { ...baseInput(ed1, "chunk_starred"), chunk_id: "c2", source_identity: "reddit.com" },
    ]);

    const stats = await repo.getSourceIdentityStats("theverge.com");
    expect(stats).toEqual({
      source_identity: "theverge.com",
      mute_count: 2,
      chunk_star_count: 1,
      cited_in_story_count: 1,
      total_signals: 5,
    });
  });

  it("getSourceIdentityStats returns zeros for a source with no signals", async () => {
    const editionId = await createEdition("2026-07-08");
    const repo = createSignalRepository(db);
    await repo.createBatch([
      baseInput(editionId, "story_up"),
    ]);
    const stats = await repo.getSourceIdentityStats("nope.example");
    expect(stats).toEqual({
      source_identity: "nope.example",
      mute_count: 0,
      chunk_star_count: 0,
      cited_in_story_count: 0,
      total_signals: 0,
    });
  });
});
