import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCTOR_HELP,
  runDoctorCommand,
  type DoctorCommandDeps,
} from "./doctor.js";
import type { Config } from "../config/index.js";
import type { PgPool } from "../database/pool.js";
import type { MinifluxClient } from "../discovery/miniflux-client.js";
import type { NotebookLmClient } from "../digest/notebooklm/notebooklm-client.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { JobStatus } from "../database/kysely.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const goodMigrationsDir = resolve(
  here,
  "..",
  "database",
  "migrations.test-fixtures",
  "good",
);

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    DATABASE_URL: "postgres://u:p@h:5432/db",
    LOG_LEVEL: "info",
    ...overrides,
  } as Config;
}

function makeFakePool(opts: {
  select1Ok?: boolean;
  applied?: string[];
}): PgPool {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (/SELECT 1/i.test(sql)) {
        if (opts.select1Ok === false) throw new Error("connection refused");
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ exists: true }] };
      }
      if (sql.includes("FROM _migrations")) {
        const rows = (opts.applied ?? []).map((filename) => ({ filename }));
        return { rows };
      }
      return { rows: [] };
    }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    eventNames: vi.fn(),
    listenerCount: vi.fn(),
    addListener: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
  } as unknown as PgPool;
}

function makeFakeQueue(opts: {
  counts?: Record<JobStatus, number>;
  throwOnCount?: boolean;
}): ProcessingJobQueue {
  return {
    enqueue: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(),
    getJob: vi.fn(),
    recoverStaleJobs: vi.fn(),
    cancelForEdition: vi.fn(),
    archiveJobs: vi.fn(),
    purgeArchivedJobs: vi.fn(),
    countByStatus: opts.throwOnCount
      ? vi.fn().mockRejectedValue(new Error("queue down"))
      : vi.fn().mockResolvedValue(
          opts.counts ?? { pending: 0, running: 0, completed: 0, failed: 0, archived: 0 },
        ),
    listFailed: vi.fn(),
    requeue: vi.fn(),
    getMetrics: vi.fn(),
  };
}

function makeFakeMiniflux(result: { ok: boolean; status: number; body?: string }): MinifluxClient {
  return {
    listUnreadEntries: vi.fn(),
    markEntryRead: vi.fn(),
    markEntriesRead: vi.fn(),
    health: vi.fn().mockResolvedValue(result),
  };
}

function makeFakeNotebookLm(ok: boolean): NotebookLmClient {
  return {
    createNotebook: vi.fn(),
    addSource: vi.fn(),
    waitForSource: vi.fn(),
    generateAudio: vi.fn(),
    waitForArtifact: vi.fn(),
    downloadAudio: vi.fn(),
    authCheck: vi.fn().mockResolvedValue({ ok, details: {} }),
    listNotebooks: vi.fn(),
  };
}

function makeFakeFetch(respond: (url: string) => { ok: boolean; status: number; body: string }) {
  return vi.fn().mockImplementation(async (url: string) => {
    const r = respond(url);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.body,
      json: async () => ({}),
      headers: new Headers(),
    } as unknown as Response;
  });
}

describe("runDoctorCommand", () => {
  it("config: ok when DATABASE_URL starts with postgres", async () => {
    const deps: DoctorCommandDeps = {
      config: makeConfig({ DATABASE_URL: "postgres://x" }),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    };
    const r = await runDoctorCommand(deps);
    const configCheck = r.report.checks.find((c) => c.name === "config");
    expect(configCheck?.ok).toBe(true);
    expect(configCheck?.detail).toContain("present");
  });

  it("config: fails when DATABASE_URL is missing or wrong scheme", async () => {
    const deps: DoctorCommandDeps = {
      config: makeConfig({ DATABASE_URL: "mysql://x" }),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    };
    const r = await runDoctorCommand(deps);
    const configCheck = r.report.checks.find((c) => c.name === "config");
    expect(configCheck?.ok).toBe(false);
  });

  it("postgres: ok when SELECT 1 succeeds", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({ select1Ok: true }),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "postgres");
    expect(check?.ok).toBe(true);
  });

  it("postgres: fails when SELECT 1 throws", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({ select1Ok: false }),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "postgres");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/connection refused/);
  });

  it("migrations: ok when applied set covers on-disk files", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({
        applied: [
          "001_create_fixture_smoke.sql",
          "002_alter_fixture_smoke.sql",
        ],
      }),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "migrations");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/2\/2 applied/);
  });

  it("migrations: fails when an on-disk file is missing from _migrations", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({
        applied: ["001_create_fixture_smoke.sql"],
      }),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "migrations");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("002_alter_fixture_smoke.sql");
  });

  it("queue: ok when failed count is at or below threshold", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({
        counts: { pending: 1, running: 0, completed: 50, failed: 100, archived: 0 },
      }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "queue");
    expect(check?.ok).toBe(true);
  });

  it("queue: fails when failed count exceeds threshold", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({
        counts: { pending: 0, running: 0, completed: 0, failed: 250, archived: 0 },
      }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "queue");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("failed=250");
  });

  it("queue: threshold override via DOCTOR_FAILED_THRESHOLD lowers the pass/fail boundary", async () => {
    const r = await runDoctorCommand({
      config: makeConfig({ DOCTOR_FAILED_THRESHOLD: "50" }),
      pool: makeFakePool({}),
      queue: makeFakeQueue({
        counts: { pending: 0, running: 0, completed: 0, failed: 60, archived: 0 },
      }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "queue");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("failed threshold=50");
    expect(check?.detail).toContain("failed=60");
  });

  it("queue: falls back to default threshold (100) when DOCTOR_FAILED_THRESHOLD is invalid", async () => {
    const r = await runDoctorCommand({
      config: makeConfig({ DOCTOR_FAILED_THRESHOLD: "not-a-number" }),
      pool: makeFakePool({}),
      queue: makeFakeQueue({
        counts: { pending: 0, running: 0, completed: 0, failed: 150, archived: 0 },
      }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "queue");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("failed threshold=100");
    expect(check?.detail).toContain("failed=150");
  });

  it("miniflux: ok when health returns ok=true", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      miniflux: makeFakeMiniflux({ ok: true, status: 200 }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "miniflux");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("status=200");
  });

  it("miniflux: fails when health returns ok=false (e.g. 401)", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      miniflux: makeFakeMiniflux({ ok: false, status: 401, body: "unauthorized" }),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "miniflux");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("status=401");
  });

  it("miniflux: skipped (ok=true) when no client is provided", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "miniflux");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/skipped/);
  });

  it("resend: ok when GET /domains returns 200", async () => {
    const fetchImpl = makeFakeFetch(() => ({
      ok: true,
      status: 200,
      body: "[]",
    }));
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      resendApiKey: "re_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "resend");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("status=200");
  });

  it("resend: fails when GET /domains returns 401", async () => {
    const fetchImpl = makeFakeFetch(() => ({
      ok: false,
      status: 401,
      body: "unauthorized",
    }));
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      resendApiKey: "re_bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "resend");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("status=401");
  });

  it("resend: skipped (ok=true) when no api key is provided", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "resend");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/skipped/);
  });

  it("notebooklm: ok when authCheck returns ok=true", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      notebookLm: makeFakeNotebookLm(true),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "notebooklm");
    expect(check?.ok).toBe(true);
  });

  it("notebooklm: fails when authCheck returns ok=false", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      notebookLm: makeFakeNotebookLm(false),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "notebooklm");
    expect(check?.ok).toBe(false);
  });

  it("notebooklm: skipped (ok=true) when no client is provided", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "notebooklm");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/skipped/);
  });

  it("workers: lists known worker names from buildPluginRegistry()", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    const check = r.report.checks.find((c) => c.name === "workers");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("expand_document");
    expect(check?.detail).toContain("cluster_stories");
  });

  it("summary: exitCode 0 when all checks pass", async () => {
    const r = await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({ applied: [
        "001_create_fixture_smoke.sql",
        "002_alter_fixture_smoke.sql",
      ] }),
      queue: makeFakeQueue({ counts: { pending: 0, running: 0, completed: 0, failed: 0, archived: 0 } }),
      migrationsDir: goodMigrationsDir,
    });
    expect(r.report.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report.checks.every((c) => c.ok)).toBe(true);
  });

  it("summary: exitCode 1 when any check fails", async () => {
    const r = await runDoctorCommand({
      config: makeConfig({ DATABASE_URL: "mysql://bad" }),
      pool: makeFakePool({}),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
    });
    expect(r.report.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report.checks.some((c) => !c.ok)).toBe(true);
  });

  it("logs one line per check and a final summary line", async () => {
    const logs: string[] = [];
    await runDoctorCommand({
      config: makeConfig(),
      pool: makeFakePool({ applied: [
        "001_create_fixture_smoke.sql",
        "002_alter_fixture_smoke.sql",
      ] }),
      queue: makeFakeQueue({}),
      migrationsDir: goodMigrationsDir,
      log: (m) => logs.push(m),
    });
    const summary = logs.find((l) => l.startsWith("summary:"));
    expect(summary).toBeDefined();
    expect(logs.filter((l) => /^(ok|fail): /.test(l)).length).toBeGreaterThanOrEqual(7);
  });

  it("DOCTOR_HELP mentions every check name", () => {
    for (const name of [
      "config",
      "postgres",
      "migrations",
      "queue",
      "miniflux",
      "resend",
      "notebooklm",
      "workers",
    ]) {
      expect(DOCTOR_HELP).toContain(name);
    }
  });
});