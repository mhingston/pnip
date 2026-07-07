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
import {
  createSectionRepository,
  type SectionRepository,
} from "./section-repository.js";

const docMigrationPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);
const sectionMigrationPath = fileURLToPath(
  new URL("../database/migrations/009_create_document_sections.sql", import.meta.url),
);
const editionMigrationPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("SectionRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let sectionRepo: SectionRepository;
  let docRepo: DocumentRepository;
  const schema = schemaName("sec_");
  let documentId: string;

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);

    const docSql = await readFile(docMigrationPath, "utf8");
    const sectionSql = await readFile(sectionMigrationPath, "utf8");
    const editionSql = await readFile(editionMigrationPath, "utf8");

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionSql);
      await client.query(docSql);
      await client.query(sectionSql);
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
    docRepo = createDocumentRepository(db);
    sectionRepo = createSectionRepository(db);

    const ed = await db
      .insertInto("editions")
      .values({ publication_date: new Date("2026-01-01") })
      .returningAll()
      .executeTakeFirstOrThrow();

    const doc = await docRepo.create({
      editionId: ed.id,
      sourceType: "article",
      sourceUrl: "https://example.com/sec-test",
    });
    documentId = doc.id;
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
    await db.deleteFrom("document_sections").execute();
  });

  it("creates sections for a document", async () => {
    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, heading: "Title", type: "title", contentMarkdown: "# Title" },
      { documentId, order: 1, heading: "Intro", type: "paragraph", contentMarkdown: "Intro text" },
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0].section_order).toBe(0);
    expect(sections[0].heading).toBe("Title");
    expect(sections[0].section_type).toBe("title");
    expect(sections[1].section_order).toBe(1);
  });

  it("getByDocumentId returns sections ordered by section_order", async () => {
    await sectionRepo.createBatch([
      { documentId, order: 1, contentText: "Second" },
      { documentId, order: 0, contentText: "First" },
    ]);

    const sections = await sectionRepo.getByDocumentId(documentId);
    expect(sections).toHaveLength(2);
    expect(sections[0].content_text).toBe("First");
    expect(sections[1].content_text).toBe("Second");
  });

  it("getByDocumentId returns empty array for unknown document", async () => {
    const sections = await sectionRepo.getByDocumentId("00000000-0000-0000-0000-000000000000");
    expect(sections).toEqual([]);
  });

  it("respects UNIQUE(document_id, section_order)", async () => {
    await sectionRepo.createBatch([
      { documentId, order: 0, contentMarkdown: "First" },
    ]);
    await expect(
      sectionRepo.createBatch([
        { documentId, order: 0, contentMarkdown: "Duplicate" },
      ]),
    ).rejects.toThrow();
  });

  it("createBatch stores metadata as JSONB and returns it", async () => {
    const sections = await sectionRepo.createBatch([
      {
        documentId,
        order: 0,
        type: "reddit_comment",
        contentMarkdown: "comment body",
        metadata: { redditCommentId: "cmt-abc" },
      },
    ]);
    expect(sections[0].metadata).toEqual({ redditCommentId: "cmt-abc" });
    const fetched = await sectionRepo.getByDocumentId(documentId);
    expect(fetched[0].metadata).toEqual({ redditCommentId: "cmt-abc" });
  });

  it("createBatch defaults metadata to {} when not provided", async () => {
    const sections = await sectionRepo.createBatch([
      { documentId, order: 0, contentMarkdown: "no meta" },
    ]);
    expect(sections[0].metadata).toEqual({});
  });

  it("getMaxOrder returns the max section_order for a document", async () => {
    await sectionRepo.createBatch([
      { documentId, order: 0 },
      { documentId, order: 5 },
      { documentId, order: 2 },
    ]);
    expect(await sectionRepo.getMaxOrder(documentId)).toBe(5);
  });

  it("getMaxOrder returns 0 when the document has no sections", async () => {
    expect(await sectionRepo.getMaxOrder(documentId)).toBe(0);
  });

  it("getByDocumentIdAndType filters by section_type", async () => {
    await sectionRepo.createBatch([
      { documentId, order: 0, type: "reddit_submission", contentMarkdown: "sub" },
      { documentId, order: 1, type: "reddit_comment", contentMarkdown: "c1" },
      { documentId, order: 2, type: "reddit_comment", contentMarkdown: "c2" },
    ]);
    const comments = await sectionRepo.getByDocumentIdAndType(
      documentId,
      "reddit_comment",
    );
    expect(comments).toHaveLength(2);
    expect(comments[0].section_type).toBe("reddit_comment");
    expect(comments[1].section_type).toBe("reddit_comment");
    expect(comments.map((s) => s.section_order)).toEqual([1, 2]);
  });
});
