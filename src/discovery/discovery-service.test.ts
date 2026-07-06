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
import type { MinifluxClient, MinifluxEntry } from "./miniflux-client.js";

const sql002Path = fileURLToPath(
  new URL("../database/migrations/002_create_processing_jobs.sql", import.meta.url),
);
const sql006Path = fileURLToPath(
  new URL("../database/migrations/006_add_depends_on_to_processing_jobs.sql", import.meta.url),
);
const sql003Path = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const sql007Path = fileURLToPath(
  new URL("../database/migrations/007_create_discovery_events.sql", import.meta.url),
);

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entry(id: number, url: string, feedId = 10): MinifluxEntry {
  return { id, feedId, title: `Entry ${id}`, url };
}

interface FakeMinifluxCalls {
  listUnread: Array<{ limit?: number; afterEntryId?: number }>;
  markEntryRead: number[];
}

function createFakeMiniflux(opts: {
  pages: MinifluxEntry[][];
  markReadThrowsIds?: number[];
}): { client: MinifluxClient; calls: FakeMinifluxCalls } {
  const calls: FakeMinifluxCalls = { listUnread: [], markEntryRead: [] };
  let pageIndex = 0;
  async function markEntryRead(id: number): Promise<void> {
    calls.markEntryRead.push(id);
    if (opts.markReadThrowsIds?.includes(id)) {
      throw new Error(`fake mark-read failure for entry ${id}`);
    }
  }
  const client: MinifluxClient = {
    async listUnreadEntries(
      listOpts?: { limit?: number; afterEntryId?: number },
    ): Promise<MinifluxEntry[]> {
      calls.listUnread.push({
        limit: listOpts?.limit,
        afterEntryId: listOpts?.afterEntryId,
      });
      const page = opts.pages[pageIndex] ?? [];
      pageIndex++;
      return page;
    },
    markEntryRead,
    async markEntriesRead(ids: number[]): Promise<void> {
      for (const id of ids) await markEntryRead(id);
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

    const [m002, m006, m003, m007] = await Promise.all([
      readFile(sql002Path, "utf8"),
      readFile(sql006Path, "utf8"),
      readFile(sql003Path, "utf8"),
      readFile(sql007Path, "utf8"),
    ]);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(m002);
      await client.query(m006);
      await client.query(m003);
      await client.query(m007);
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
      `TRUNCATE TABLE ${schema}.processing_jobs, ${schema}.discovery_events, ${schema}.editions RESTART IDENTITY CASCADE`,
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

  it("happy path: discovers 2 entries, creates events + expand_document jobs, marks both read", async () => {
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
    expect(calls.markEntryRead).toEqual([1, 2]);
  });

  it("idempotency: pre-existing event is not re-enqueued; mark-read still called for the duplicate", async () => {
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
    expect(calls.markEntryRead).toEqual([1, 2]);
  });

  it("§52 isolation: mark-read failure for one entry does not abort the run; persist+enqueue still counted", async () => {
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
    expect(result.failed).toBe(1);
    expect(await discoveryRepo.countByEdition(result.editionId)).toBe(2);
    expect(await countJobs()).toBe(2);
    expect(calls.markEntryRead).toEqual([1, 2]);
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
    expect(calls.markEntryRead).toEqual([1, 2, 3]);
    expect(calls.listUnread.map((c) => c.limit)).toEqual([2, 2]);
    expect(calls.listUnread.map((c) => c.afterEntryId)).toEqual([undefined, 2]);
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
    expect(await countJobs()).toBe(0);
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
      expect(calls.markEntryRead).toEqual([2]);

      const sentinelEvent = await discoveryRepo.getByMinifluxEntryId(1);
      expect(sentinelEvent).toBeUndefined();
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS reject_sentinel_trigger ON ${schema}.processing_jobs`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${schema}.reject_sentinel_url()`);
    }
  });
});
