import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/index.js";
import { createPool, closePool, type PgPool } from "./pool.js";
import { runMigrations, getAppliedMigrations } from "./migrations.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const realDir = resolve(here, "migrations");
const goodFixtures = resolve(here, "migrations.test-fixtures", "good");
const badFixtures = resolve(here, "migrations.test-fixtures", "bad");

const CLEANUP =
  "DROP TABLE IF EXISTS _migrations, __smoke, __fixture_smoke, __bad_table, embeddings, quality_classifications, topic_assignments, topics, entity_mentions, entities, summary_citations, summaries, processing_jobs, discovery_events, editions, prompt_versions, document_lineage, documents, document_sections, document_chunks CASCADE";

describe("migration runner", () => {
  let pool: PgPool;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
  });

  beforeEach(async () => {
    await pool.query(CLEANUP);
  });

  afterEach(async () => {
    await pool.query(CLEANUP);
  });

  afterAll(async () => {
    if (pool) await closePool(pool);
  });

  it("applies the 001 migration from the real migrations dir and records it in _migrations", async () => {
    const res = await runMigrations(pool, { directory: realDir });
    expect(res.applied).toEqual([
      "001_create_smoke_table.sql",
      "002_create_processing_jobs.sql",
      "003_create_editions.sql",
      "004_create_prompt_versions.sql",
      "005_create_document_lineage.sql",
      "006_add_depends_on_to_processing_jobs.sql",
      "007_create_discovery_events.sql",
      "008_create_documents.sql",
      "009_create_document_sections.sql",
      "010_create_document_chunks.sql",
      "011_create_pgvector_extension.sql",
      "012_create_summaries.sql",
      "013_create_entities.sql",
      "014_create_topics.sql",
      "015_create_quality_classifications.sql",
      "016_create_embeddings.sql",
    ]);
    expect(res.skipped).toEqual([]);

    expect(await getAppliedMigrations(pool)).toEqual([
      "001_create_smoke_table.sql",
      "002_create_processing_jobs.sql",
      "003_create_editions.sql",
      "004_create_prompt_versions.sql",
      "005_create_document_lineage.sql",
      "006_add_depends_on_to_processing_jobs.sql",
      "007_create_discovery_events.sql",
      "008_create_documents.sql",
      "009_create_document_sections.sql",
      "010_create_document_chunks.sql",
      "011_create_pgvector_extension.sql",
      "012_create_summaries.sql",
      "013_create_entities.sql",
      "014_create_topics.sql",
      "015_create_quality_classifications.sql",
      "016_create_embeddings.sql",
    ]);

    const r = await pool.query("SELECT to_regclass('__smoke') AS exists");
    expect(r.rows[0].exists).not.toBeNull();

    const jobs = await pool.query(
      "SELECT to_regclass('processing_jobs') AS exists",
    );
    expect(jobs.rows[0].exists).not.toBeNull();

    const editions = await pool.query(
      "SELECT to_regclass('editions') AS exists",
    );
    expect(editions.rows[0].exists).not.toBeNull();

    const prompts = await pool.query(
      "SELECT to_regclass('prompt_versions') AS exists",
    );
    expect(prompts.rows[0].exists).not.toBeNull();

    const lineage = await pool.query(
      "SELECT to_regclass('document_lineage') AS exists",
    );
    expect(lineage.rows[0].exists).not.toBeNull();

    const discovery = await pool.query(
      "SELECT to_regclass('discovery_events') AS exists",
    );
    expect(discovery.rows[0].exists).not.toBeNull();
  });

  it("is idempotent: a second runMigrations skips already-applied migrations", async () => {
    await runMigrations(pool, { directory: realDir });
    const res2 = await runMigrations(pool, { directory: realDir });
    expect(res2.applied).toEqual([]);
    expect(res2.skipped).toEqual([
      "001_create_smoke_table.sql",
      "002_create_processing_jobs.sql",
      "003_create_editions.sql",
      "004_create_prompt_versions.sql",
      "005_create_document_lineage.sql",
      "006_add_depends_on_to_processing_jobs.sql",
      "007_create_discovery_events.sql",
      "008_create_documents.sql",
      "009_create_document_sections.sql",
      "010_create_document_chunks.sql",
      "011_create_pgvector_extension.sql",
      "012_create_summaries.sql",
      "013_create_entities.sql",
      "014_create_topics.sql",
      "015_create_quality_classifications.sql",
      "016_create_embeddings.sql",
    ]);

    expect(await getAppliedMigrations(pool)).toEqual([
      "001_create_smoke_table.sql",
      "002_create_processing_jobs.sql",
      "003_create_editions.sql",
      "004_create_prompt_versions.sql",
      "005_create_document_lineage.sql",
      "006_add_depends_on_to_processing_jobs.sql",
      "007_create_discovery_events.sql",
      "008_create_documents.sql",
      "009_create_document_sections.sql",
      "010_create_document_chunks.sql",
      "011_create_pgvector_extension.sql",
      "012_create_summaries.sql",
      "013_create_entities.sql",
      "014_create_topics.sql",
      "015_create_quality_classifications.sql",
      "016_create_embeddings.sql",
    ]);
  });

  it("applies multiple good migrations in sorted order from a fixtures dir", async () => {
    const res = await runMigrations(pool, { directory: goodFixtures });
    expect(res.applied).toEqual([
      "001_create_fixture_smoke.sql",
      "002_alter_fixture_smoke.sql",
    ]);
    expect(res.skipped).toEqual([]);

    expect(await getAppliedMigrations(pool)).toEqual([
      "001_create_fixture_smoke.sql",
      "002_alter_fixture_smoke.sql",
    ]);
  });

  it("rolls back a failing migration, does not record it, and throws naming the file", async () => {
    await expect(runMigrations(pool, { directory: badFixtures })).rejects.toThrow(
      /002_bad\.sql/,
    );

    expect(await getAppliedMigrations(pool)).toEqual([
      "001_create_fixture_smoke.sql",
    ]);

    const smoke = await pool.query(
      "SELECT to_regclass('__fixture_smoke') AS exists",
    );
    expect(smoke.rows[0].exists).not.toBeNull();

    const bad = await pool.query("SELECT to_regclass('__bad_table') AS exists");
    expect(bad.rows[0].exists).toBeNull();
  });

  it("getAppliedMigrations returns [] when no _migrations table exists", async () => {
    expect(await getAppliedMigrations(pool)).toEqual([]);
  });
});
