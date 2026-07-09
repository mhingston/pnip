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
  type DiscoveryEvent,
} from "../database/kysely.js";
import {
  createDiscoveryRepository,
  type DiscoveryRepository,
} from "./discovery-repository.js";

const editionsSqlPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const discoverySqlPath = fileURLToPath(
  new URL("../database/migrations/007_create_discovery_events.sql", import.meta.url),
);

function readSql(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const E1 = "00000000-0000-0000-0000-000000000001";
const E2 = "00000000-0000-0000-0000-000000000002";

describe("DiscoveryRepository", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let repo: DiscoveryRepository;
  const schema = schemaName("discovery_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const editionsSql = await readSql(editionsSqlPath);
    const discoverySql = await readSql(discoverySqlPath);

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
      await client.query(editionsSql);
      await client.query(discoverySql);
      await client.query(partitionSql);
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
    repo = createDiscoveryRepository(db);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE ${schema}.discovery_events, ${schema}.editions RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function insertEdition(id: string, date: string): Promise<void> {
    await pool.query(
      `INSERT INTO ${schema}.editions (id, publication_date, status) VALUES ($1, $2, 'building')`,
      [id, date],
    );
  }

  async function insertEventDirect(opts: {
    editionId: string;
    minifluxEntryId: number;
    feedId: number;
    url: string;
    discoveredAt: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${schema}.discovery_events (edition_id, miniflux_entry_id, feed_id, url, discovered_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        opts.editionId,
        opts.minifluxEntryId,
        opts.feedId,
        opts.url,
        opts.discoveredAt,
      ],
    );
  }

  it("getOrCreate creates a new discovery event with created=true", async () => {
    await insertEdition(E1, "2026-01-01");
    const { event, created } = await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 100,
      feedId: 7,
      url: "https://x/y",
    });
    expect(created).toBe(true);
    expect(event.id).toBeTruthy();
    expect(event.edition_id).toBe(E1);
    expect(event.miniflux_entry_id).toBe("100");
    expect(event.feed_id).toBe("7");
    expect(event.url).toBe("https://x/y");
    expect(event.discovered_at).toBeInstanceOf(Date);
    expect(event.created_at).toBeInstanceOf(Date);
  });

  it("getOrCreate is idempotent: same miniflux_entry_id returns created=false with the same id and no second row", async () => {
    await insertEdition(E1, "2026-01-01");
    const first = await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 101,
      feedId: 7,
      url: "https://x/101",
    });
    expect(first.created).toBe(true);

    const second = await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 101,
      feedId: 7,
      url: "https://x/101",
    });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.miniflux_entry_id).toBe("101");

    expect(await repo.countByEdition(E1)).toBe(1);
  });

  it("getOrCreate is race-safe: parallel calls yield exactly one row and one created=true", async () => {
    await insertEdition(E1, "2026-01-01");
    const [a, b] = await Promise.all([
      repo.getOrCreate({
        editionId: E1,
        minifluxEntryId: 200,
        feedId: 7,
        url: "https://x/200",
      }),
      repo.getOrCreate({
        editionId: E1,
        minifluxEntryId: 200,
        feedId: 7,
        url: "https://x/200",
      }),
    ]);
    expect(a.created).not.toBe(b.created);
    expect(a.event.id).toBe(b.event.id);
    expect(a.event.miniflux_entry_id).toBe("200");
    expect(await repo.countByEdition(E1)).toBe(1);
  });

  it("getByMinifluxEntryId returns the event, or undefined for unknown ids", async () => {
    await insertEdition(E1, "2026-01-01");
    expect(
      await repo.getByMinifluxEntryId(300),
    ).toBeUndefined();

    await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 300,
      feedId: 9,
      url: "https://x/300",
    });
    const found = await repo.getByMinifluxEntryId(300);
    expect(found).toBeDefined();
    expect(found!.miniflux_entry_id).toBe("300");
    expect(found!.url).toBe("https://x/300");
  });

  it("getById returns the event, or undefined for unknown ids", async () => {
    await insertEdition(E1, "2026-01-01");
    expect(await repo.getById(randomUUID())).toBeUndefined();

    const { event } = await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 301,
      feedId: 9,
      url: "https://x/301",
    });
    const found = await repo.getById(event.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(event.id);
  });

  it("listByEdition returns events ordered by discovered_at ASC and scoped to the edition", async () => {
    await insertEdition(E1, "2026-01-01");
    await insertEdition(E2, "2026-01-02");

    await insertEventDirect({
      editionId: E1,
      minifluxEntryId: 10,
      feedId: 1,
      url: "https://x/10",
      discoveredAt: "2026-01-03T00:00:00Z",
    });
    await insertEventDirect({
      editionId: E1,
      minifluxEntryId: 11,
      feedId: 1,
      url: "https://x/11",
      discoveredAt: "2026-01-01T00:00:00Z",
    });
    await insertEventDirect({
      editionId: E1,
      minifluxEntryId: 12,
      feedId: 1,
      url: "https://x/12",
      discoveredAt: "2026-01-02T00:00:00Z",
    });
    await insertEventDirect({
      editionId: E2,
      minifluxEntryId: 13,
      feedId: 1,
      url: "https://x/13",
      discoveredAt: "2026-01-01T00:00:00Z",
    });

    const list = await repo.listByEdition(E1);
    expect(list).toHaveLength(3);
    const entryIds = (list as DiscoveryEvent[]).map((e) => e.miniflux_entry_id);
    expect(entryIds).toEqual(["11", "12", "10"]);
    expect((list as DiscoveryEvent[]).every((e) => e.edition_id === E1)).toBe(true);
  });

  it("countByEdition returns the count for an edition and 0 for an empty edition", async () => {
    await insertEdition(E1, "2026-01-01");
    await insertEdition(E2, "2026-01-02");

    expect(await repo.countByEdition(E1)).toBe(0);

    await repo.getOrCreate({ editionId: E1, minifluxEntryId: 401, feedId: 1, url: "https://x/401" });
    await repo.getOrCreate({ editionId: E1, minifluxEntryId: 402, feedId: 1, url: "https://x/402" });
    await repo.getOrCreate({ editionId: E1, minifluxEntryId: 403, feedId: 1, url: "https://x/403" });

    expect(await repo.countByEdition(E1)).toBe(3);
    expect(await repo.countByEdition(E2)).toBe(0);
  });

  it("FK enforcement: getOrCreate with a non-existent edition_id rejects with a foreign_key_violation", async () => {
    const missingEdition = randomUUID();
    await expect(
      repo.getOrCreate({
        editionId: missingEdition,
        minifluxEntryId: 500,
        feedId: 1,
        url: "https://x/500",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("UNIQUE(miniflux_entry_id): a direct duplicate insert rejects with a unique_violation", async () => {
    await insertEdition(E1, "2026-01-01");
    await repo.getOrCreate({
      editionId: E1,
      minifluxEntryId: 600,
      feedId: 1,
      url: "https://x/600",
    });
    await expect(
      pool.query(
        `INSERT INTO ${schema}.discovery_events (edition_id, miniflux_entry_id, feed_id, url) VALUES ($1, $2, $3, $4)`,
        [E1, 600, 1, "https://x/600-dup"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
