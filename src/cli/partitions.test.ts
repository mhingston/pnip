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
  parsePartitionsFlags,
  runPartitionsCommand,
  PARTITIONS_HELP,
} from "./partitions.js";

const editionsSqlPath = fileURLToPath(
  new URL("../database/migrations/003_create_editions.sql", import.meta.url),
);
const documentsSqlPath = fileURLToPath(
  new URL("../database/migrations/008_create_documents.sql", import.meta.url),
);

function readSql(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function schemaName(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "");
}

const PARTITION_ALTER_SQL = `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'editions') THEN
      ALTER TABLE editions ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'documents') THEN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT 'master';
    END IF;
  END $$;
`;

describe("parsePartitionsFlags", () => {
  it("returns help=false and no errors on empty args", () => {
    const r = parsePartitionsFlags({ args: [] });
    expect(r.help).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it("records -h and --help as help requests", () => {
    expect(parsePartitionsFlags({ args: ["-h"] }).help).toBe(true);
    expect(parsePartitionsFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on unknown flags", () => {
    const r = parsePartitionsFlags({ args: ["--unknown"] });
    expect(r.errors).toEqual(["unknown flag: --unknown"]);
    expect(r.help).toBe(false);
  });
});

describe("PARTITIONS_HELP", () => {
  it("mentions the partitions command name, --help flag, and read-only guarantee", () => {
    expect(PARTITIONS_HELP).toContain("digestive partitions");
    expect(PARTITIONS_HELP).toContain("--help");
    expect(PARTITIONS_HELP).toMatch(/read-only/i);
  });
});

describe("runPartitionsCommand (db-backed)", () => {
  let pool: PgPool;
  let kyselyPool: PgPool;
  let db: Kysely<Database>;
  const schema = schemaName("partitions_cmd_test_");

  beforeAll(async () => {
    const url = loadConfig({ force: true }).TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL must be set for integration tests");
    }
    pool = createPool(url);
    kyselyPool = createPool(url);

    const editionsSql = await readSql(editionsSqlPath);
    const documentsSql = await readSql(documentsSqlPath);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(editionsSql);
      await client.query(documentsSql);
      await client.query(PARTITION_ALTER_SQL);
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

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${schema}.documents CASCADE`);
    await pool.query(`TRUNCATE TABLE ${schema}.editions CASCADE`);
  });

  afterAll(async () => {
    await closeKysely(db);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closePool(pool);
  });

  async function insertEdition(date: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ${schema}.editions (id, publication_date, status)
       VALUES ($1, $2::date, 'building')`,
      [id, date],
    );
    return id;
  }

  async function insertDocument(opts: {
    editionId: string;
    partitionKey: string;
    url: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${schema}.documents (edition_id, source_type, source_url, partition_key)
       VALUES ($1, 'article', $2, $3)`,
      [opts.editionId, opts.url, opts.partitionKey],
    );
  }

  it("empty DB prints total=0 and a 'no partitions' line plus an empty 7-day block", async () => {
    const logs: string[] = [];
    const deps = { db, log: (m: string) => logs.push(m) };
    const r = await runPartitionsCommand(deps);
    expect(r.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("0 total partitions"))).toBe(true);
    expect(logs.some((l) => l.includes("(no partitions"))).toBe(true);
    expect(logs.some((l) => l.includes("last 7 days"))).toBe(true);
    expect(logs.some((l) => l.includes("(no editions in the last 7 days"))).toBe(
      true,
    );
  });

  it("two editions with mixed partitions renders the table and 7-day block with expected counts", async () => {
    const today = new Date();
    const fmt = (d: Date): string => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    };
    const todayStr = fmt(today);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = fmt(yesterday);

    const edToday = await insertEdition(todayStr);
    const edYesterday = await insertEdition(yesterdayStr);

    for (let i = 0; i < 4; i++) {
      await insertDocument({
        editionId: edToday,
        partitionKey: "master",
        url: `https://example.com/today/master/${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertDocument({
        editionId: edToday,
        partitionKey: "youtube",
        url: `https://example.com/today/yt/${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertDocument({
        editionId: edYesterday,
        partitionKey: "master",
        url: `https://example.com/yday/master/${i}`,
      });
    }
    await insertDocument({
      editionId: edYesterday,
      partitionKey: "blogs",
      url: "https://example.com/yday/blogs/0",
    });

    const logs: string[] = [];
    const deps = { db, log: (m: string) => logs.push(m) };
    const r = await runPartitionsCommand(deps);
    expect(r.exitCode).toBe(0);

    const header = logs.find((l) => l.startsWith("partitions: "));
    expect(header).toBeDefined();
    expect(header).toContain("3 total partitions, 10 total documents");

    const tableHeader = logs.find(
      (l) =>
        l.startsWith("partition") &&
        l.includes("total_docs") &&
        l.includes("days") &&
        l.includes("latest_date") &&
        l.includes("latest_count"),
    );
    expect(tableHeader).toBeDefined();

    const masterRow = logs.find((l) => l.startsWith("master"));
    expect(masterRow).toBeDefined();
    expect(masterRow).toContain("7");
    expect(masterRow).toContain(todayStr);

    const ytRow = logs.find((l) => l.startsWith("youtube"));
    expect(ytRow).toBeDefined();
    expect(ytRow).toContain("2");
    expect(ytRow).toContain(todayStr);

    const blogsRow = logs.find((l) => l.startsWith("blogs"));
    expect(blogsRow).toBeDefined();
    expect(blogsRow).toContain("1");
    expect(blogsRow).toContain(yesterdayStr);

    const last7Header = logs.find((l) => l === "last 7 days (date, partition → count):");
    expect(last7Header).toBeDefined();

    const todayDayLine = logs.find(
      (l) => l.startsWith(`  ${todayStr}`),
    );
    expect(todayDayLine).toBeDefined();
    expect(todayDayLine).toContain("master=4");
    expect(todayDayLine).toContain("youtube=2");
    expect(todayDayLine).not.toContain("blogs");

    const yesterdayDayLine = logs.find(
      (l) => l.startsWith(`  ${yesterdayStr}`),
    );
    expect(yesterdayDayLine).toBeDefined();
    expect(yesterdayDayLine).toContain("master=3");
    expect(yesterdayDayLine).toContain("blogs=1");
    expect(yesterdayDayLine).not.toContain("youtube");
  });
});