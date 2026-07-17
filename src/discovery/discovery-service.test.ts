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
import {
  createEditionRepository,
  type EditionRepository,
} from "../editions/edition-repository.js";
import {
  createDiscoveryRepository,
  type DiscoveryRepository,
} from "./discovery-repository.js";
import {
  createProcessingJobQueue,
  type ProcessingJobQueue,
} from "../jobs/queue/processing-job-queue.js";
import { createDiscoveryService } from "./discovery-service.js";
import type {
  MinifluxClient,
  MinifluxEntry,
  MinifluxCategory,
  ListMinifluxEntriesOptions,
} from "./miniflux-client.js";

const sql002Path = fileURLToPath(
  new URL("../database/migrations/002_create_processing_jobs.sql", import.meta.url),
);
const sql006Path = fileURLToPath(
  new URL("../database/migrations/006_add_depends_on_to_processing_jobs.sql", import.meta.url),
);
const sql003Path = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const sql019Path = fileURLToPath(
  new URL(
    "../database/migrations/019_add_cluster_stories_enqueued_at_to_editions.sql",
    import.meta.url,
  ),
);
const sql007Path = fileURLToPath(
  new URL("../database/migrations/007_create_discovery_events.sql", import.meta.url),
);
const sql028Path = fileURLToPath(
  new URL("../database/migrations/028_create_miniflux_ingestion_state.sql", import.meta.url),
);
const sql029Path = fileURLToPath(
  new URL("../database/migrations/029_add_miniflux_read_reset_at.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entry(
  id: number,
  url: string,
  feedId = 10,
  category?: MinifluxCategory,
): MinifluxEntry {
  return { id, feedId, title: `Entry ${id}`, url, category: category ?? null };
}

interface FakeMinifluxCalls {
  listUnread: Array<{
    limit?: number;
    afterEntryId?: number;
    beforeEntryId?: number;
    direction?: string;
    status?: string;
  }>;
  listEntries: Array<{
    limit?: number;
    afterEntryId?: number;
    beforeEntryId?: number;
    direction?: string;
    status?: string;
  }>;
  markAllFeedsRead: number;
  markEntryRead: number[];
}

function createFakeMiniflux(opts: {
  pages: MinifluxEntry[][];
  markReadThrowsIds?: number[];
  markAllFeedsReadThrows?: boolean;
}): { client: MinifluxClient; calls: FakeMinifluxCalls } {
  const calls: FakeMinifluxCalls = {
    listUnread: [],
    listEntries: [],
    markAllFeedsRead: 0,
    markEntryRead: [],
  };
  let pageIndex = 0;
  async function markEntryRead(id: number): Promise<void> {
    calls.markEntryRead.push(id);
    if (opts.markReadThrowsIds?.includes(id)) {
      throw new Error(`fake mark-read failure for entry ${id}`);
    }
  }
  const client: MinifluxClient = {
    async listEntries(
      listOpts?: ListMinifluxEntriesOptions,
    ): Promise<MinifluxEntry[]> {
      calls.listEntries.push({
        limit: listOpts?.limit,
        afterEntryId: listOpts?.afterEntryId,
        beforeEntryId: listOpts?.beforeEntryId,
        direction: listOpts?.direction,
        status: listOpts?.status,
      });
      calls.listUnread.push({
        limit: listOpts?.limit,
        afterEntryId: listOpts?.afterEntryId,
        beforeEntryId: listOpts?.beforeEntryId,
        direction: listOpts?.direction,
        status: listOpts?.status,
      });
      const page = opts.pages[pageIndex] ?? [];
      pageIndex++;
      return page;
    },
    async listUnreadEntries(
      listOpts?: { limit?: number; afterEntryId?: number },
    ): Promise<MinifluxEntry[]> {
      return this.listEntries!({ ...listOpts, status: "unread" });
    },
    async markAllFeedsRead(): Promise<void> {
      calls.markAllFeedsRead++;
      if (opts.markAllFeedsReadThrows) throw new Error("fake mark-all-read failure");
    },
    markEntryRead,
    async markEntriesRead(ids: number[]): Promise<void> {
      for (const id of ids) await markEntryRead(id);
    },
    async health() {
      return { ok: true, status: 200 };
    },
  };
  return { client, calls };
}

describe("DiscoveryService", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  let editionRepo: EditionRepository;
  let discoveryRepo: DiscoveryRepository;
  let queue: ProcessingJobQueue;
  const schema = schemaName("discovery_svc_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const [m002, m006, m003, m019, m007, m028, m029] = await Promise.all([
      readFile(sql002Path, "utf8"),
      readFile(sql006Path, "utf8"),
      readFile(sql003Path, "utf8"),
      readFile(sql019Path, "utf8"),
      readFile(sql007Path, "utf8"),
      readFile(sql028Path, "utf8"),
      readFile(sql029Path, "utf8"),
    ]);

    const m026 = `
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
      await client.query(m002);
      await client.query(m006);
      await client.query(m003);
      await client.query(m019);
      await client.query(m007);
      await client.query(m026);
      await client.query(m028);
      await client.query(m029);
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
    editionRepo = createEditionRepository(db);
    discoveryRepo = createDiscoveryRepository(db);
    queue = createProcessingJobQueue(db);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE ${schema}.processing_jobs, ${schema}.discovery_events, ${schema}.miniflux_ingestion_state, ${schema}.editions RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function countJobs(): Promise<number> {
    const rows = await db.selectFrom("processing_jobs").select("id").execute();
    return rows.length;
  }

  async function getJobs() {
    return db
      .selectFrom("processing_jobs")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
  }

  it("happy path: discovers 2 entries without changing Miniflux read state", async () => {
    const { client, calls } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1"), entry(2, "https://x/2")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-01",
      miniflux: client,
    });

    const edition = await editionRepo.getByDate("2026-01-01");
    expect(edition).toBeDefined();
    expect(result.editionId).toBe(edition!.id);
    expect(result.total).toBe(2);
    expect(result.created).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.enqueued).toBe(2);
    expect(result.failed).toBe(0);

    expect(await discoveryRepo.countByEdition(edition!.id)).toBe(2);
    const jobs = await getJobs();
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.job_type).toBe("expand_document");
      expect(j.edition_id).toBe(edition!.id);
      expect(j.status).toBe("pending");
      const target = j.target as { discoveryEventId: string; url: string };
      expect(target.discoveryEventId).toMatch(UUID_RE);
      expect(typeof target.url).toBe("string");
    }
    expect(calls.markEntryRead).toEqual([]);
    expect(calls.markAllFeedsRead).toBe(1);
    expect(calls.listEntries[0]?.status).toBe("all");
  });

  it("invalidates a queued cluster snapshot when a late entry is discovered", async () => {
    const edition = await editionRepo.create("2026-01-01");
    await db
      .updateTable("editions")
      .set({ cluster_stories_enqueued_at: new Date() })
      .where("id", "=", edition.id)
      .execute();

    const { client } = createFakeMiniflux({
      pages: [[entry(3, "https://x/late")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    await service.discover({ editionDate: "2026-01-01", miniflux: client });

    expect((await editionRepo.getById(edition.id))?.cluster_stories_enqueued_at).toBeNull();
  });

  it("idempotency: pre-existing event is not re-enqueued", async () => {
    const edition = await editionRepo.getOrCreateForDate("2026-01-02");
    await discoveryRepo.getOrCreate({
      editionId: edition.id,
      minifluxEntryId: 1,
      feedId: 10,
      title: "Entry 1",
      url: "https://x/1",
    });

    const { client, calls } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1"), entry(2, "https://x/2")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-02",
      miniflux: client,
    });

    expect(result.editionId).toBe(edition.id);
    expect(result.total).toBe(2);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(0);

    expect(await discoveryRepo.countByEdition(edition.id)).toBe(2);
    expect(await countJobs()).toBe(1);
    const jobs = await getJobs();
    const target = jobs[0].target as { discoveryEventId: string; url: string };
    expect(target.url).toBe("https://x/2");
    expect(calls.markEntryRead).toEqual([]);
    expect(calls.markAllFeedsRead).toBe(1);
  });

  it("marks feeds read once while continuing to ingest entries", async () => {
    const { client, calls } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1"), entry(2, "https://x/2")], []],
      markReadThrowsIds: [1],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-03",
      miniflux: client,
    });

    expect(result.total).toBe(2);
    expect(result.created).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);
    expect(await discoveryRepo.countByEdition(result.editionId)).toBe(2);
    expect(await countJobs()).toBe(2);
    expect(calls.markEntryRead).toEqual([]);
    expect(calls.markAllFeedsRead).toBe(1);
  });

  it("pagination: advances afterEntryId and terminates on a short page", async () => {
    const { client, calls } = createFakeMiniflux({
      pages: [
        [entry(1, "https://x/1"), entry(2, "https://x/2")],
        [entry(3, "https://x/3")],
        [],
      ],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-04",
      miniflux: client,
      limit: 2,
    });

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);
    expect(result.enqueued).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls.markEntryRead).toEqual([]);
    expect(calls.markAllFeedsRead).toBe(1);
    expect(calls.listUnread.map((c) => c.limit)).toEqual([2, 2]);
    expect(calls.listUnread.map((c) => c.afterEntryId)).toEqual([undefined, 2]);
  });

  it("fills a short edition from recent unprocessed history without moving the cursor backward", async () => {
    const { client, calls } = createFakeMiniflux({
      pages: [
        [entry(100, "https://www.youtube.com/watch?v=100"), entry(101, "https://www.youtube.com/watch?v=101")],
        [
          entry(90, "https://www.youtube.com/watch?v=90"),
          entry(89, "https://www.reddit.com/r/example/89"),
          entry(88, "https://blog.example.com/88"),
        ],
      ],
    });
    const service = createDiscoveryService({
      db,
      editionRepo,
      discoveryRepo,
      queue,
      minimumEntries: 5,
      lookbackDays: 7,
      sourceBalance: true,
    });

    const result = await service.discover({
      editionDate: "2026-01-10",
      miniflux: client,
    });

    expect(result.created).toBe(5);
    expect(result.enqueued).toBe(5);
    expect(await discoveryRepo.countByEdition(result.editionId)).toBe(5);
    const state = await db
      .selectFrom("miniflux_ingestion_state")
      .select("last_entry_id")
      .executeTakeFirst();
    expect(state?.last_entry_id).toBe("101");
    expect(calls.listEntries[1]).toMatchObject({
      beforeEntryId: 101,
      direction: "desc",
      status: "all",
    });
    expect(
      JSON.stringify((await discoveryRepo.getByMinifluxEntryId(89))?.metadata),
    ).toContain("reddit");
  });

  it("expand_document job shape: jobType, editionId, target{discoveryEventId,url}, status=pending", async () => {
    const { client } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-05",
      miniflux: client,
    });

    const jobs = await getJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job.job_type).toBe("expand_document");
    expect(job.edition_id).toBe(result.editionId);
    expect(job.status).toBe("pending");
    const target = job.target as { discoveryEventId: string; url: string };
    expect(target.discoveryEventId).toMatch(UUID_RE);
    expect(target.url).toBe("https://x/1");

    const event = await discoveryRepo.getByMinifluxEntryId(1);
    expect(event).toBeDefined();
    expect(target.discoveryEventId).toBe(event!.id);
    const edition = await editionRepo.getById(result.editionId);
    expect(edition?.miniflux_read_reset_at).toBeInstanceOf(Date);
  });

  it("empty unread: total=0, edition created, markEntryRead not called", async () => {
    const { client, calls } = createFakeMiniflux({ pages: [[]] });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-06",
      miniflux: client,
    });

    expect(result.total).toBe(0);
    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(result.failed).toBe(0);

    const edition = await editionRepo.getByDate("2026-01-06");
    expect(edition).toBeDefined();
    expect(result.editionId).toBe(edition!.id);
    expect(calls.markEntryRead).toEqual([]);
    expect(calls.markAllFeedsRead).toBe(1);
    expect(await countJobs()).toBe(0);
  });

  it("marks the Miniflux boundary once per edition and retries a failed reset", async () => {
    const first = createFakeMiniflux({
      pages: [[entry(1, "https://x/1")], []],
      markAllFeedsReadThrows: true,
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });

    const firstResult = await service.discover({
      editionDate: "2026-01-10",
      miniflux: first.client,
    });
    expect(first.calls.markAllFeedsRead).toBe(1);
    expect((await editionRepo.getById(firstResult.editionId))?.miniflux_read_reset_at).toBeNull();

    const second = createFakeMiniflux({ pages: [[]] });
    const secondResult = await service.discover({
      editionDate: "2026-01-10",
      miniflux: second.client,
    });
    expect(secondResult.editionId).toBe(firstResult.editionId);
    expect(second.calls.markAllFeedsRead).toBe(1);
    expect((await editionRepo.getById(firstResult.editionId))?.miniflux_read_reset_at).toBeInstanceOf(Date);

    const third = createFakeMiniflux({ pages: [[]] });
    await service.discover({ editionDate: "2026-01-10", miniflux: third.client });
    expect(third.calls.markAllFeedsRead).toBe(0);
  });

  it("routes entries after a published edition into the next open edition", async () => {
    const published = await editionRepo.create("2026-01-11");
    await editionRepo.transition(published.id, "ready");
    await editionRepo.transition(published.id, "publishing");
    await editionRepo.transition(published.id, "published");

    const { client, calls } = createFakeMiniflux({
      pages: [[entry(99, "https://x/99")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-01-11",
      miniflux: client,
    });

    const next = await editionRepo.getByDate("2026-01-12");
    expect(next).toBeDefined();
    expect(result.editionId).toBe(next!.id);
    expect(result.editionId).not.toBe(published.id);
    expect(await discoveryRepo.getByMinifluxEntryId(99)).toMatchObject({
      edition_id: next!.id,
    });
    expect(calls.markAllFeedsRead).toBe(1);
  });

  it("§52 isolation: enqueue failure rolls back the event (atomic tx) and the run continues", async () => {
    const sentinelUrl = "https://sentinel/fail";
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${schema}.reject_sentinel_url() RETURNS trigger AS $$
      BEGIN
        IF (NEW.target->>'url') = '${sentinelUrl}' THEN
          RAISE EXCEPTION 'sentinel url rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER reject_sentinel_trigger BEFORE INSERT ON ${schema}.processing_jobs
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_sentinel_url();
    `);

    try {
      const { client, calls } = createFakeMiniflux({
        pages: [[entry(1, sentinelUrl), entry(2, "https://x/2")], []],
      });
      const service = createDiscoveryService({
        db,
        editionRepo,
        discoveryRepo,
        queue,
      });
      const result = await service.discover({
        editionDate: "2026-01-07",
        miniflux: client,
      });

      expect(result.total).toBe(2);
      expect(result.created).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.failed).toBe(1);
      expect(await discoveryRepo.countByEdition(result.editionId)).toBe(1);
      expect(await countJobs()).toBe(1);
      const jobs = await getJobs();
      const target = jobs[0].target as { url: string };
      expect(target.url).toBe("https://x/2");
      expect(calls.markEntryRead).toEqual([]);
      expect(calls.markAllFeedsRead).toBe(1);

      const sentinelEvent = await discoveryRepo.getByMinifluxEntryId(1);
      expect(sentinelEvent).toBeUndefined();
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS reject_sentinel_trigger ON ${schema}.processing_jobs`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${schema}.reject_sentinel_url()`);
    }
  });

  it("partition_key: with no partitionConfig, every category routes to master", async () => {
    const { client } = createFakeMiniflux({
      pages: [
        [
          entry(1, "https://x/1", 10, { id: 2, title: "Blogs" }),
          entry(2, "https://x/2", 11, { id: 3, title: "YouTube" }),
          entry(3, "https://x/3", 12, { id: 4, title: "Reddit" }),
        ],
        [],
      ],
    });
    const service = createDiscoveryService({
      db,
      editionRepo,
      discoveryRepo,
      queue,
    });
    const result = await service.discover({
      editionDate: "2026-02-01",
      miniflux: client,
    });

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);

    const event1 = await discoveryRepo.getByMinifluxEntryId(1);
    const event2 = await discoveryRepo.getByMinifluxEntryId(2);
    const event3 = await discoveryRepo.getByMinifluxEntryId(3);
    expect(event1).toBeDefined();
    expect(event1!.partition_key).toBe("master");
    expect(event2!.partition_key).toBe("master");
    expect(event3!.partition_key).toBe("master");
  });

  it("partition_key: with partitionConfig mapping Blogs->custom_part, Blogs entries route to custom_part and others fall back to master", async () => {
    const { client } = createFakeMiniflux({
      pages: [
        [
          entry(1, "https://x/1", 10, { id: 2, title: "Blogs" }),
          entry(2, "https://x/2", 11, { id: 3, title: "YouTube" }),
          entry(3, "https://x/3", 12, { id: 4, title: "Reddit" }),
        ],
        [],
      ],
    });
    const service = createDiscoveryService({
      db,
      editionRepo,
      discoveryRepo,
      queue,
      partitionConfig: {
        custom_part: { category: "Blogs", min_articles: 5, enabled: true },
      },
    });
    const result = await service.discover({
      editionDate: "2026-02-08",
      miniflux: client,
    });

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);

    const event1 = await discoveryRepo.getByMinifluxEntryId(1);
    const event2 = await discoveryRepo.getByMinifluxEntryId(2);
    const event3 = await discoveryRepo.getByMinifluxEntryId(3);
    expect(event1!.partition_key).toBe("custom_part");
    expect(event2!.partition_key).toBe("master");
    expect(event3!.partition_key).toBe("master");
  });

  it("partition_key: resolver itself maps to master by default (no config)", async () => {
    const { client } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1", 10, { id: 3, title: "YouTube" })], []],
    });
    const service = createDiscoveryService({
      db,
      editionRepo,
      discoveryRepo,
      queue,
    });
    const result = await service.discover({
      editionDate: "2026-02-09",
      miniflux: client,
    });
    expect(result.created).toBe(1);
    const event = await discoveryRepo.getByMinifluxEntryId(1);
    expect(event!.partition_key).toBe("master");
  });

  it("partition_key: entry with no category defaults to 'master'", async () => {
    const { client } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1")], []],
    });
    const service = createDiscoveryService({ db, editionRepo, discoveryRepo, queue });
    const result = await service.discover({
      editionDate: "2026-02-02",
      miniflux: client,
    });

    expect(result.total).toBe(1);
    expect(result.created).toBe(1);

    const event = await discoveryRepo.getByMinifluxEntryId(1);
    expect(event).toBeDefined();
    expect(event!.partition_key).toBe("master");
  });

  it("partition_key: expand_document job target carries the resolved partitionKey", async () => {
    const { client } = createFakeMiniflux({
      pages: [[entry(1, "https://x/1", 10, { id: 3, title: "YouTube" })], []],
    });
    const service = createDiscoveryService({
      db,
      editionRepo,
      discoveryRepo,
      queue,
      partitionConfig: {
        youtube: { category: "YouTube", min_articles: 5, enabled: true },
      },
    });
    const result = await service.discover({
      editionDate: "2026-02-03",
      miniflux: client,
    });

    expect(result.created).toBe(1);
    const jobs = await getJobs();
    expect(jobs).toHaveLength(1);
    const target = jobs[0].target as {
      discoveryEventId: string;
      url: string;
      title: string;
      partitionKey: string;
    };
    expect(target.partitionKey).toBe("youtube");
    expect(target.url).toBe("https://x/1");
    expect(target.title).toBe("Entry 1");
  });
});
