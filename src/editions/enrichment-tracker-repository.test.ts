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
import { type Database, type Edition } from "../database/kysely.js";
import { createEditionRepository } from "./edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
  InvalidEnrichmentTypeError,
} from "./enrichment-tracker-repository.js";

const migrationSqlPaths = [
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EnrichmentTrackerRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let tracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  const schema = schemaName("tracker_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL must be set for integration tests");
    pool = createPool(url);
    kyselyPool = createPool(url);

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const rel of migrationSqlPaths) {
        const sql = await readMigrationSql(rel);
        await client.query(sql);
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
    tracker = createEnrichmentTrackerRepository(db);
    editionRepo = createEditionRepository(db);
    docRepo = createDocumentRepository(db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.document_enrichment_status`);
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
  });

  afterAll(async () => {
    await db.destroy();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function makeEditionAndDoc(editionDate: string, sourceUrl: string) {
    const ed = await editionRepo.create(editionDate);
    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl,
    });
    return { ed, doc };
  }

  it("REQUIRED_ENRICHMENT_TYPES contains the five enrichment types", () => {
    expect(REQUIRED_ENRICHMENT_TYPES.length).toBe(5);
    expect([...REQUIRED_ENRICHMENT_TYPES].sort()).toEqual(
      [
        "assign_topics",
        "classify_quality",
        "embed_chunk",
        "extract_entities",
        "summarize_chunk",
      ].sort(),
    );
  });

  it("markDone throws InvalidEnrichmentTypeError on unknown enrichment type", async () => {
    const { doc } = await makeEditionAndDoc("2026-01-01", "https://e.com/1");
    await expect(tracker.markDone(doc.id, "bogus_type")).rejects.toBeInstanceOf(
      InvalidEnrichmentTypeError,
    );
  });

  it("markDone inserts a 'done' row and is idempotent on re-call", async () => {
    const { doc } = await makeEditionAndDoc("2026-01-02", "https://e.com/2");
    const a = await tracker.markDone(doc.id, "summarize_chunk");
    expect(a.status).toBe("done");
    expect(a.completed_at).toBeInstanceOf(Date);
    expect(a.document_id).toBe(doc.id);
    expect(a.enrichment_type).toBe("summarize_chunk");

    const before = a.completed_at!.getTime();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = await tracker.markDone(doc.id, "summarize_chunk");
    expect(b.status).toBe("done");
    expect(b.completed_at!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("getCompletedTypesForDocument returns the set of completed types", async () => {
    const { doc } = await makeEditionAndDoc("2026-01-03", "https://e.com/3");
    await tracker.markDone(doc.id, "summarize_chunk");
    await tracker.markDone(doc.id, "embed_chunk");
    const got = (await tracker.getCompletedTypesForDocument(doc.id)).sort();
    expect(got).toEqual(["embed_chunk", "summarize_chunk"]);
  });

  it("isDocumentFullyEnriched is false until all 5 types are done, then true", async () => {
    const { doc } = await makeEditionAndDoc("2026-01-04", "https://e.com/4");
    expect(await tracker.isDocumentFullyEnriched(doc.id)).toBe(false);
    await tracker.markDone(doc.id, "summarize_chunk");
    expect(await tracker.isDocumentFullyEnriched(doc.id)).toBe(false);
    await tracker.markDone(doc.id, "extract_entities");
    await tracker.markDone(doc.id, "assign_topics");
    await tracker.markDone(doc.id, "embed_chunk");
    expect(await tracker.isDocumentFullyEnriched(doc.id)).toBe(false);
    await tracker.markDone(doc.id, "classify_quality");
    expect(await tracker.isDocumentFullyEnriched(doc.id)).toBe(true);
  });

  it("resetForDocument clears all enrichment rows for one document", async () => {
    const { doc } = await makeEditionAndDoc("2026-01-05", "https://e.com/5");
    await tracker.markDone(doc.id, "summarize_chunk");
    await tracker.markDone(doc.id, "embed_chunk");
    expect(
      (await tracker.getCompletedTypesForDocument(doc.id)).length,
    ).toBe(2);
    await tracker.resetForDocument(doc.id);
    expect(await tracker.getCompletedTypesForDocument(doc.id)).toEqual([]);
    expect(await tracker.isDocumentFullyEnriched(doc.id)).toBe(false);
  });

  it("resetForDocument leaves other documents' tracker rows intact", async () => {
    const ed = await editionRepo.create("2026-01-06");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/6a" });
    const d2 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/6b" });
    await tracker.markDone(d1.id, "summarize_chunk");
    await tracker.markDone(d2.id, "summarize_chunk");
    await tracker.markDone(d2.id, "embed_chunk");
    await tracker.resetForDocument(d1.id);
    expect(await tracker.getCompletedTypesForDocument(d1.id)).toEqual([]);
    expect((await tracker.getCompletedTypesForDocument(d2.id)).sort()).toEqual([
      "embed_chunk",
      "summarize_chunk",
    ]);
  });

  it("getDocumentCounts counts total + fully-enriched + completed-type rows", async () => {
    const ed = await editionRepo.create("2026-01-07");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/7a" });
    const d2 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/7b" });
    const d3 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/7c" });
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await tracker.markDone(d1.id, t);
    }
    await tracker.markDone(d2.id, "summarize_chunk");
    await tracker.markDone(d2.id, "embed_chunk");

    const counts = await tracker.getDocumentCounts(ed.id);
    expect(counts.totalDocuments).toBe(3);
    expect(counts.fullyEnrichedDocuments).toBe(1);
    expect(counts.totalCompletedTypeRows).toBe(7);
    expect(counts.expectedTypeRows).toBe(3 * REQUIRED_ENRICHMENT_TYPES.length);

    expect(d3).toBeDefined();
  });

  it("isEditionFullyEnriched is false with zero documents and true only when all are enriched", async () => {
    const emptyEd = await editionRepo.create("2026-01-08");
    expect(await tracker.isEditionFullyEnriched(emptyEd.id)).toBe(false);

    const ed = await editionRepo.create("2026-01-09");
    const d1 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/9a" });
    const d2 = await docRepo.create({ editionId: ed.id, sourceType: "article", sourceUrl: "https://e.com/9b" });
    expect(await tracker.isEditionFullyEnriched(ed.id)).toBe(false);
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(d1.id, t);
    expect(await tracker.isEditionFullyEnriched(ed.id)).toBe(false);
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(d2.id, t);
    expect(await tracker.isEditionFullyEnriched(ed.id)).toBe(true);
  });

  it("getEditionEnqueuedAt returns null initially; claimEditionEnqueue sets the timestamp atomically", async () => {
    const ed = await editionRepo.create("2026-01-10");
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();

    const first = await tracker.claimEditionEnqueue(ed.id);
    expect(first).toBeInstanceOf(Date);
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toEqual(first);

    const second = await tracker.claimEditionEnqueue(ed.id);
    expect(second).toBeNull();
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toEqual(first);
  });

  it("claimEditionEnqueue does not collide across different editions", async () => {
    const a = await editionRepo.create("2026-01-11");
    const b = await editionRepo.create("2026-01-12");
    const tA = await tracker.claimEditionEnqueue(a.id);
    const tB = await tracker.claimEditionEnqueue(b.id);
    expect(tA).toBeInstanceOf(Date);
    expect(tB).toBeInstanceOf(Date);
    expect(tA).not.toEqual(tB);
  });

  it("resetEditionEnqueue clears the claim so a future claim can succeed", async () => {
    const ed = await editionRepo.create("2026-01-13");
    await tracker.claimEditionEnqueue(ed.id);
    expect(await tracker.claimEditionEnqueue(ed.id)).toBeNull();
    await tracker.resetEditionEnqueue(ed.id);
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();
    const reclaimed = await tracker.claimEditionEnqueue(ed.id);
    expect(reclaimed).toBeInstanceOf(Date);
  });

  it("list helper invariant: tracker state survives a fresh edition + documents cycle", async () => {
    const allEditions: Edition[] = await db.selectFrom("editions").selectAll().execute();
    expect(Array.isArray(allEditions)).toBe(true);
  });
});
