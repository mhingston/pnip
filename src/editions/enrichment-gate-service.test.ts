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
import { type Database } from "../database/kysely.js";
import { createEditionRepository } from "./edition-repository.js";
import { createDocumentRepository } from "../expansion/document-repository.js";
import {
  createEnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "./enrichment-gate-service.js";

const migrationSqlPaths = [
  "../database/migrations/003_create_editions.sql",
  "../database/migrations/008_create_documents.sql",
  "../database/migrations/018_create_document_enrichment_status.sql",
  "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
];

const partitionKeyDdl = `
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

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EnrichmentGateService", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let gate: ReturnType<typeof createEnrichmentGateService>;
  let tracker: ReturnType<typeof createEnrichmentTrackerRepository>;
  let editionRepo: ReturnType<typeof createEditionRepository>;
  let docRepo: ReturnType<typeof createDocumentRepository>;
  const schema = schemaName("gate_test_");

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
      await client.query(partitionKeyDdl);
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
    gate = createEnrichmentGateService({ db, tracker });
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

  async function makeEdition(editionDate: string) {
    const ed = await editionRepo.create(editionDate);
    return ed;
  }

  async function makeDoc(editionId: string, sourceUrl: string) {
    return docRepo.create({ editionId, sourceType: "article", sourceUrl });
  }

  async function markAllBut(editionId: string, documentId: string, skip: string) {
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      if (t === skip) continue;
      await tracker.markDone(documentId, t);
    }
  }

  it("returns null when the document is not yet fully enriched after the mark", async () => {
    const ed = await makeEdition("2026-02-02");
    const doc = await makeDoc(ed.id, "https://e.com/2");
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      if (t === "summarize_chunk" || t === "classify_quality") continue;
      await tracker.markDone(doc.id, t);
    }
    const out = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(out).toBeNull();
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();
    expect(
      (await tracker.getCompletedTypesForDocument(doc.id)).length,
    ).toBe(4);
  });

  it("returns null when the document is fully enriched but other edition documents are not", async () => {
    const ed = await makeEdition("2026-02-03");
    const d1 = await makeDoc(ed.id, "https://e.com/3a");
    const d2 = await makeDoc(ed.id, "https://e.com/3b");
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(d1.id, t);
    await markAllBut(ed.id, d2.id, "embed_chunk");
    const out = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      d2.id,
      "summarize_chunk",
    );
    expect(out).toBeNull();
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();
  });

  it("enqueues cluster_stories exactly once when the last enrichment completes the edition", async () => {
    const ed = await makeEdition("2026-02-04");
    const doc = await makeDoc(ed.id, "https://e.com/4");
    await markAllBut(ed.id, doc.id, "classify_quality");
    const out = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "classify_quality",
    );
    expect(out).not.toBeNull();
    expect(out!.jobType).toBe("cluster_stories");
    expect(out!.editionId).toBe(ed.id);
    expect(out!.target).toEqual({ editionId: ed.id });
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeInstanceOf(Date);
  });

  it("does not re-enqueue cluster_stories on a redundant later completion", async () => {
    const ed = await makeEdition("2026-02-05");
    const doc = await makeDoc(ed.id, "https://e.com/5");
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(doc.id, t);
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();
    const first = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(first).not.toBeNull();
    const second = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(second).toBeNull();
    const third = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "embed_chunk",
    );
    expect(third).toBeNull();
  });

  it("is exactly-once under concurrent completion of the final enrichment type", async () => {
    const ed = await makeEdition("2026-02-06");
    const d1 = await makeDoc(ed.id, "https://e.com/6a");
    const d2 = await makeDoc(ed.id, "https://e.com/6b");
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      if (t === "embed_chunk") continue;
      await tracker.markDone(d1.id, t);
      await tracker.markDone(d2.id, t);
    }

    const [a, b] = await Promise.all([
      gate.markEnrichmentDoneAndMaybeEnqueueCluster(ed.id, d1.id, "embed_chunk"),
      gate.markEnrichmentDoneAndMaybeEnqueueCluster(ed.id, d2.id, "embed_chunk"),
    ]);
    const claimed = [a, b].filter((x) => x !== null);
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.jobType).toBe("cluster_stories");
    expect(claimed[0]!.editionId).toBe(ed.id);
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeInstanceOf(Date);
  });

  it("after resetForDocument, a subsequent markDone on the new chunk set can re-enqueue (after resetEditionEnqueue)", async () => {
    const ed = await makeEdition("2026-02-07");
    const doc = await makeDoc(ed.id, "https://e.com/7");
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(doc.id, t);
    const first = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(first).not.toBeNull();

    await tracker.resetForDocument(doc.id);
    for (const t of REQUIRED_ENRICHMENT_TYPES) await tracker.markDone(doc.id, t);
    const after = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(after).toBeNull();
    await tracker.resetEditionEnqueue(ed.id);
    const re = await gate.markEnrichmentDoneAndMaybeEnqueueCluster(
      ed.id,
      doc.id,
      "summarize_chunk",
    );
    expect(re).not.toBeNull();
    expect(re!.jobType).toBe("cluster_stories");
  });

  it("invalid enrichment type throws InvalidEnrichmentTypeError and does not mark done or enqueue", async () => {
    const ed = await makeEdition("2026-02-08");
    const doc = await makeDoc(ed.id, "https://e.com/8");
    await expect(
      gate.markEnrichmentDoneAndMaybeEnqueueCluster(ed.id, doc.id, "bogus"),
    ).rejects.toThrow(/invalid enrichment type/i);
    expect(await tracker.getCompletedTypesForDocument(doc.id)).toEqual([]);
    expect(await tracker.getEditionEnqueuedAt(ed.id)).toBeNull();
  });
});
