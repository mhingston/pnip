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
  createEmailDigestRepository,
  EmailDigestConflictError,
} from "./email-digest-repository.js";

const migrationSqlPaths = [
  "../../database/migrations/003_create_editions.sql",
  "../../database/migrations/021_create_email_digests.sql",
];

function readMigrationSql(relativePath: string): Promise<string> {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFile(fullPath, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

describe("EmailDigestRepository", () => {
  let pool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("emailrepo_");

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
    await db.deleteFrom("email_digests").execute();
    await db.deleteFrom("editions").execute();
  });

  it("persists an email digest row for an edition", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-07");
    const row = await repo.createForEdition({
      editionId: ed.id,
      subject: "Daily Digest — 2026-07-07",
      htmlContent: "<p>HTML</p>",
      textContent: "HTML",
      fromAddress: "from@example.com",
      toAddresses: ["to@example.com"],
    });
    expect(row.edition_id).toBe(ed.id);
    expect(row.subject).toBe("Daily Digest — 2026-07-07");
    expect(row.delivery_status).toBe("pending");
    expect(row.attempt_count).toBe(0);
    expect(row.provider_message_id).toBeNull();
  });

  it("enforces UNIQUE(edition_id) idempotency", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-08");
    await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "x",
      textContent: "x",
      fromAddress: "f",
      toAddresses: ["t"],
    });
    await expect(
      repo.createForEdition({
        editionId: ed.id,
        subject: "x",
        htmlContent: "x",
        textContent: "x",
        fromAddress: "f",
        toAddresses: ["t"],
      }),
    ).rejects.toBeInstanceOf(EmailDigestConflictError);
  });

  it("persists provider_message_id and provider_response", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-09");
    const row = await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
      deliveryStatus: "sent",
      attemptCount: 1,
      providerMessageId: "msg-123",
      providerResponse: { id: "msg-123", status: "sent" },
    });
    expect(row.provider_message_id).toBe("msg-123");
    expect(row.delivery_status).toBe("sent");
    expect(row.attempt_count).toBe(1);
  });

  it("updateDelivery records attempt + provider response", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-10");
    const created = await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
      deliveryStatus: "pending",
    });
    const updated = await repo.updateDelivery(created.id, {
      deliveryStatus: "sent",
      attemptCount: 1,
      providerResponse: { id: "msg-x" },
      providerMessageId: "msg-x",
      failureReason: null,
      attemptedAt: new Date(),
      completedAt: new Date(),
    });
    expect(updated.delivery_status).toBe("sent");
    expect(updated.attempt_count).toBe(1);
    expect(updated.provider_message_id).toBe("msg-x");
  });

  it("updateDelivery is a no-op when the row is already in the target status", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-11");
    const created = await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
      deliveryStatus: "sent",
      attemptCount: 1,
      providerMessageId: "msg-original",
    });
    const updated = await repo.updateDelivery(created.id, {
      deliveryStatus: "sent",
      attemptCount: 5,
      providerResponse: { same: true },
      providerMessageId: "msg-y",
      failureReason: null,
      attemptedAt: new Date(),
      completedAt: new Date(),
    });
    // No-op: existing row is returned with its original values, not the
    // proposed update values.
    expect(updated.delivery_status).toBe("sent");
    expect(updated.attempt_count).toBe(1);
    expect(updated.provider_message_id).toBe("msg-original");
  });

  it("updateDelivery does apply when the row is in a different status (pending → sent)", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-12");
    const created = await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
      deliveryStatus: "pending",
    });
    const updated = await repo.updateDelivery(created.id, {
      deliveryStatus: "sent",
      attemptCount: 1,
      providerResponse: { id: "msg-z" },
      providerMessageId: "msg-z",
      failureReason: null,
      attemptedAt: new Date(),
      completedAt: new Date(),
    });
    expect(updated.delivery_status).toBe("sent");
    expect(updated.attempt_count).toBe(1);
    expect(updated.provider_message_id).toBe("msg-z");
  });

  it("getByEdition returns the row or undefined", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-12");
    await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
    });
    const got = await repo.getByEdition(ed.id);
    expect(got).toBeDefined();
    const missing = await repo.getByEdition("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeUndefined();
  });

  it("deleteByEdition removes the row", async () => {
    const editionRepo = createEditionRepository(db);
    const repo = createEmailDigestRepository(db);
    const ed = await editionRepo.create("2026-07-13");
    await repo.createForEdition({
      editionId: ed.id,
      subject: "x",
      htmlContent: "h",
      textContent: "t",
      fromAddress: "f",
      toAddresses: ["t"],
    });
    await repo.deleteByEdition(ed.id);
    expect(await repo.getByEdition(ed.id)).toBeUndefined();
  });
});
