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
} from "../database/kysely.js";
import {
  createDocumentRepository,
  type DocumentRepository,
} from "./document-repository.js";

const docMigrationPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);
const editionMigrationPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const promptVersionsMigrationPath = fileURLToPath(
  new URL("../database/migrations/004_create_prompt_versions.sql", import.meta.url),
);
const documentSectionsMigrationPath = fileURLToPath(
  new URL("../database/migrations/009_create_document_sections.sql", import.meta.url),
);
const documentChunksMigrationPath = fileURLToPath(
  new URL("../database/migrations/010_create_document_chunks.sql", import.meta.url),
);
const storyClustersMigrationPath = fileURLToPath(
  new URL(
    "../database/migrations/017_create_story_clusters.sql",
    import.meta.url,
  ),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("DocumentRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: DocumentRepository;
  const schema = schemaName("doc_");
  let editionId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const docSql = await readFile(docMigrationPath, "utf8");
    const editionSql = await readFile(editionMigrationPath, "utf8");

    const partitionSql = `
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'editions') THEN
          ALTER TABLE editions ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'discovery_events') THEN
          ALTER TABLE discovery_events ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'documents') THEN
          ALTER TABLE documents ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
      END $$;
    `;

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(partitionSql);
    } finally {
      client.release();
    }

    kyselyPool = createPool(url);
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
    repo = createDocumentRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-01-01") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;
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
    await db.deleteFrom("documents").execute();
  });

  it("creates a document and returns it", async () => {
    const doc = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/article",
      title: "Test Article",
    });

    expect(doc.id).toBeDefined();
    expect(doc.source_type).toBe("article");
    expect(doc.source_url).toBe("https://example.com/article");
    expect(doc.title).toBe("Test Article");
    expect(doc.language).toBe("en");
  });

  it("getById returns undefined for missing document", async () => {
    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("getById returns the document", async () => {
    const created = await repo.create({
      editionId,
      sourceType: "youtube",
      sourceUrl: "https://youtube.com/watch?v=xyz",
    });
    const found = await repo.getById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("getByEdition returns documents for the edition", async () => {
    const d1 = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/a",
    });
    const d2 = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/b",
    });

    const docs = await repo.getByEdition(editionId);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it("getByEditionAndUrl finds existing document by URL", async () => {
    const created = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/unique",
    });
    const found = await repo.getByEditionAndUrl(editionId, "https://example.com/unique");
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("getByEditionAndUrl returns undefined for unknown URL", async () => {
    expect(await repo.getByEditionAndUrl(editionId, "https://example.com/unknown")).toBeUndefined();
  });

  it("respects UNIQUE(edition_id, source_url)", async () => {
    await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/dup",
    });
    await expect(
      repo.create({
        editionId,
        sourceType: "article",
        sourceUrl: "https://example.com/dup",
      }),
    ).rejects.toThrow();
  });

  it("stores optional fields", async () => {
    const doc = await repo.create({
      editionId,
      sourceType: "article",
      sourceUrl: "https://example.com/full",
      title: "Full Article",
      canonicalUrl: "https://example.com/canonical",
      authors: ["Alice", "Bob"],
      publishedAt: new Date("2026-06-01"),
      language: "fr",
      contentMarkdown: "# Hello",
      contentText: "Hello",
      metadata: { key: "val" },
    });

    expect(doc.title).toBe("Full Article");
    expect(doc.canonical_url).toBe("https://example.com/canonical");
    expect(doc.language).toBe("fr");
    expect(doc.content_markdown).toBe("# Hello");
    expect(doc.content_text).toBe("Hello");
  });
});

describe("DocumentRepository.getRankedByEditionAndPartition", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: DocumentRepository;
  const schema = schemaName("doc_rank_");
  let editionId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const docSql = await readFile(docMigrationPath, "utf8");
    const editionSql = await readFile(editionMigrationPath, "utf8");
    const storyClustersSql = await readFile(storyClustersMigrationPath, "utf8");
    const promptVersionsSql = await readFile(promptVersionsMigrationPath, "utf8");
    const documentSectionsSql = await readFile(documentSectionsMigrationPath, "utf8");
    const documentChunksSql = await readFile(documentChunksMigrationPath, "utf8");

    const partitionSql = `
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'editions') THEN
          ALTER TABLE editions ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'discovery_events') THEN
          ALTER TABLE discovery_events ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'documents') THEN
          ALTER TABLE documents ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
        END IF;
      END $$;
    `;

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(promptVersionsSql);
      await client.query(docSql);
      await client.query(documentSectionsSql);
      await client.query(documentChunksSql);
      await client.query(storyClustersSql);
      await client.query(partitionSql);
    } finally {
      client.release();
    }

    kyselyPool = createPool(url);
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
    repo = createDocumentRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-01-02") })
      .returningAll()
      .executeTakeFirstOrThrow();
    editionId = ed.id;
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
    await db.deleteFrom("documents").execute();
  });

  async function seedDocs(n: number, prefix = "doc"): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const idx = String(i).padStart(3, "0");
      const doc = await repo.create({
        editionId,
        sourceType: "article",
        sourceUrl: `https://example.com/${prefix}/${idx}`,
        title: `Doc ${idx}`,
      });
      ids.push(doc.id);
    }
    return ids;
  }

  async function seedCluster(
    clusterOrder: number,
    label: string,
    documentIds: string[],
  ): Promise<string> {
    const cluster = await db
      .insertInto("story_clusters")
      .values({
        edition_id: editionId,
        cluster_order: clusterOrder,
        label,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    for (const documentId of documentIds) {
      await db
        .insertInto("cluster_members")
        .values({
          story_id: cluster.id,
          document_id: documentId,
          similarity: 0,
        })
        .execute();
    }
    return cluster.id;
  }

  it("returns kept=[] excluded=[] when there are no documents", async () => {
    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      50,
    );
    expect(result).toEqual({ kept: [], excluded: [] });
  });

  it("returns all docs as kept when count <= limit and none are clustered", async () => {
    const ids = await seedDocs(10);
    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      50,
    );
    expect(result.excluded).toEqual([]);
    expect(result.kept.map((d) => d.id)).toEqual(
      [...ids].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("ranks unclustered docs by document id ASC and drops the tail when over the limit", async () => {
    const ids = await seedDocs(60);
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      50,
    );
    expect(result.kept).toHaveLength(50);
    expect(result.excluded).toHaveLength(10);
    expect(result.kept.map((d) => d.id)).toEqual(sortedIds.slice(0, 50));
    expect(result.excluded.map((d) => d.id)).toEqual(sortedIds.slice(50, 60));
  });

  it("ranks clustered docs by cluster_order ASC then by document id, with unclustered at the end", async () => {
    const clusterDocs = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (clusterIdx) =>
        seedDocs(10, `c${clusterIdx}`),
      ),
    );
    const unclusteredIds = await seedDocs(5, "unc");
    await seedCluster(0, "top", clusterDocs[0]!);
    await seedCluster(1, "second", clusterDocs[1]!);
    await seedCluster(2, "third", clusterDocs[2]!);
    await seedCluster(3, "fourth", clusterDocs[3]!);
    await seedCluster(4, "fifth", clusterDocs[4]!);
    await seedCluster(5, "sixth", clusterDocs[5]!);

    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      50,
    );
    expect(result.kept).toHaveLength(50);
    expect(result.excluded).toHaveLength(15);

    const keptIds = new Set(result.kept.map((d) => d.id));
    const excludedIds = new Set(result.excluded.map((d) => d.id));

    const expectedKept = new Set([
      ...clusterDocs[0]!,
      ...clusterDocs[1]!,
      ...clusterDocs[2]!,
      ...clusterDocs[3]!,
      ...clusterDocs[4]!,
    ]);
    const expectedExcluded = new Set([
      ...clusterDocs[5]!,
      ...unclusteredIds,
    ]);

    expect(keptIds).toEqual(expectedKept);
    expect(excludedIds).toEqual(expectedExcluded);

    const cluster0Set = new Set(clusterDocs[0]!);
    const cluster1Set = new Set(clusterDocs[1]!);
    const unclusteredSet = new Set(unclusteredIds);
    const lastKeptPos = result.kept.length - 1;
    let firstCluster1Pos = -1;
    let firstUnclusteredPos = -1;
    for (let i = 0; i < result.kept.length; i++) {
      const id = result.kept[i]!.id;
      if (cluster1Set.has(id) && firstCluster1Pos === -1) firstCluster1Pos = i;
      if (unclusteredSet.has(id) && firstUnclusteredPos === -1) {
        firstUnclusteredPos = i;
      }
    }
    for (const cluster0Id of cluster0Set) {
      const pos = result.kept.findIndex((d) => d.id === cluster0Id);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThan(firstCluster1Pos === -1 ? Infinity : firstCluster1Pos);
    }
    void lastKeptPos;
    expect(firstUnclusteredPos).toBe(-1);
  });

  it("drops unclustered docs when there are already enough clustered docs to fill the cap", async () => {
    const cluster0Ids = await seedDocs(10, "c0");
    const unclusteredIds = await seedDocs(5, "unc");
    await seedCluster(0, "top", cluster0Ids);

    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      10,
    );
    expect(result.kept).toHaveLength(10);
    expect(result.excluded).toHaveLength(5);
    expect(new Set(result.kept.map((d) => d.id))).toEqual(new Set(cluster0Ids));
    expect(new Set(result.excluded.map((d) => d.id))).toEqual(
      new Set(unclusteredIds),
    );
  });

  it("uses the lowest cluster_order when a document is in multiple clusters", async () => {
    const ids = await seedDocs(3, "d");
    await seedCluster(2, "low-priority", [ids[1]!]);
    await seedCluster(5, "high-priority", [ids[0]!]);
    await seedCluster(0, "top", [ids[0]!, ids[1]!]);
    await seedCluster(7, "lowest", [ids[2]!]);

    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "master",
      50,
    );
    const expectedOrder = [...[ids[0]!, ids[1]!]].sort((a, b) =>
      a.localeCompare(b),
    );
    expectedOrder.push(ids[2]!);
    expect(result.kept.map((d) => d.id)).toEqual(expectedOrder);
  });

  it("only returns documents in the requested partition", async () => {
    const masterIds = await seedDocs(3, "m");
    const ytIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const doc = await repo.create({
        editionId,
        sourceType: "youtube",
        sourceUrl: `https://youtube.com/yt/${i}`,
        partitionKey: "youtube",
      });
      ytIds.push(doc.id);
    }
    const result = await repo.getRankedByEditionAndPartition(
      editionId,
      "youtube",
      50,
    );
    expect(result.kept.map((d) => d.id)).toEqual([...ytIds].sort());
    expect(result.kept.every((d) => d.partition_key === "youtube")).toBe(true);
    expect(result.kept.length).toBe(3);
    void masterIds;
  });
});
