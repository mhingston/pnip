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
  createProvenanceRepository,
  type ProvenanceRepository,
  type LineageEdge,
  type EntityRef,
} from "./provenance-repository.js";

const migrationSqlPath = fileURLToPath(
  new URL("../database/migrations/005_create_document_lineage.sql", import.meta.url),
);

function readMigrationSql(): Promise<string> {
  return readFile(migrationSqlPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const D1 = "00000000-0000-0000-0000-000000000001";
const D2 = "00000000-0000-0000-0000-000000000002";
const S1 = "00000000-0000-0000-0000-000000000011";
const S2 = "00000000-0000-0000-0000-000000000012";
const C1 = "00000000-0000-0000-0000-000000000021";
const C2 = "00000000-0000-0000-0000-000000000022";
const A1 = "00000000-0000-0000-0000-000000000031";
const A2 = "00000000-0000-0000-0000-000000000032";
const X = "00000000-0000-0000-0000-000000000041";
const Y = "00000000-0000-0000-0000-000000000042";

const doc = (id: string): EntityRef => ({ type: "document", id });
const section = (id: string): EntityRef => ({ type: "section", id });
const chunk = (id: string): EntityRef => ({ type: "chunk", id });
const artifact = (id: string): EntityRef => ({ type: "artifact", id });

describe("ProvenanceRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: ProvenanceRepository;
  const schema = schemaName("provenance_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const sqlText = await readMigrationSql();
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(sqlText);
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
    repo = createProvenanceRepository(db);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.document_lineage`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  it("recordLineage + getSources/getConsumers: artifact cites chunk (source=artifact, target=chunk)", async () => {
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });

    const sourcesOfA1 = await repo.getSources(artifact(A1));
    expect(sourcesOfA1).toHaveLength(1);
    const edge = sourcesOfA1[0] as LineageEdge;
    expect(edge.source_type).toBe("artifact");
    expect(edge.source_id).toBe(A1);
    expect(edge.target_type).toBe("chunk");
    expect(edge.target_id).toBe(C1);
    expect(edge.relation).toBe("cite");

    const consumersOfC1 = await repo.getConsumers(chunk(C1));
    expect(consumersOfC1).toHaveLength(1);
    expect((consumersOfC1[0] as LineageEdge).source_id).toBe(A1);
  });

  it("idempotency: recording the same edge twice produces no duplicate", async () => {
    const edge = {
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    };
    await repo.recordLineage(edge);
    await repo.recordLineage(edge);

    const sources = await repo.getSources(artifact(A1));
    expect(sources).toHaveLength(1);

    await repo.recordLineageBatch([edge, edge, edge]);
    const sourcesAfterBatch = await repo.getSources(artifact(A1));
    expect(sourcesAfterBatch).toHaveLength(1);
  });

  it("resolveCitations: returns distinct chunk ids the artifact cites", async () => {
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C2,
      relation: "supports",
    });

    const cited = await repo.resolveCitations(A1);
    expect(cited.sort()).toEqual([C1, C2]);
  });

  it("§25 one-chunk-multiple-claims: getConsumers(chunk) returns all citing artifacts", async () => {
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A2,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });

    const consumers = await repo.getConsumers(chunk(C1));
    expect(consumers).toHaveLength(2);
    const citingArtifactIds = consumers
      .map((e) => (e as LineageEdge).source_id)
      .sort();
    expect(citingArtifactIds).toEqual([A1, A2]);

    expect(await repo.resolveCitations(A1)).toContain(C1);
    expect(await repo.resolveCitations(A2)).toContain(C1);
  });

  it("resolveToDocuments: walks A1→C1→S1→D1 and returns [D1]", async () => {
    await repo.recordLineage({
      sourceType: "section",
      sourceId: S1,
      targetType: "document",
      targetId: D1,
      relation: "section_of",
    });
    await repo.recordLineage({
      sourceType: "chunk",
      sourceId: C1,
      targetType: "section",
      targetId: S1,
      relation: "chunk_of",
    });
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });

    const docs = await repo.resolveToDocuments(artifact(A1));
    expect(docs).toEqual([D1]);
  });

  it("resolveToDocuments: multiple docs via two cited chunks", async () => {
    await repo.recordLineage({
      sourceType: "section",
      sourceId: S1,
      targetType: "document",
      targetId: D1,
      relation: "section_of",
    });
    await repo.recordLineage({
      sourceType: "chunk",
      sourceId: C1,
      targetType: "section",
      targetId: S1,
      relation: "chunk_of",
    });
    await repo.recordLineage({
      sourceType: "section",
      sourceId: S2,
      targetType: "document",
      targetId: D2,
      relation: "section_of",
    });
    await repo.recordLineage({
      sourceType: "chunk",
      sourceId: C2,
      targetType: "section",
      targetId: S2,
      relation: "chunk_of",
    });
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C1,
      relation: "cite",
    });
    await repo.recordLineage({
      sourceType: "artifact",
      sourceId: A1,
      targetType: "chunk",
      targetId: C2,
      relation: "cite",
    });

    const docs = await repo.resolveToDocuments(artifact(A1));
    expect(docs.sort()).toEqual([D1, D2]);
  });

  it("cycle guard: X↔Y cycle terminates and returns [] (no document ancestors)", async () => {
    await repo.recordLineage({
      sourceType: "chunk",
      sourceId: X,
      targetType: "chunk",
      targetId: Y,
      relation: "cite",
    });
    await repo.recordLineage({
      sourceType: "chunk",
      sourceId: Y,
      targetType: "chunk",
      targetId: X,
      relation: "cite",
    });

    const docs = await repo.resolveToDocuments(chunk(X));
    expect(docs).toEqual([]);
  });

  it("getSources/getConsumers on an entity with no edges return []", async () => {
    expect(await repo.getSources(artifact(A1))).toEqual([]);
    expect(await repo.getConsumers(chunk(C1))).toEqual([]);
    expect(await repo.resolveToDocuments(artifact(A1))).toEqual([]);
    expect(await repo.resolveCitations(A1)).toEqual([]);
  });
});
