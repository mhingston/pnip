import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_MAINTENANCE_OPTIONS,
  MAINTENANCE_HELP,
  parseMaintenanceFlags,
  runMaintenance,
  type RunMaintenanceInput,
} from "./maintenance.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";

function makeFakeQueue(opts: {
  archived?: number;
  purged?: number;
  counts?: { pending: number; running: number; completed: number; failed: number; archived: number };
}): ProcessingJobQueue {
  return {
    enqueue: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(),
    getJob: vi.fn(),
    recoverStaleJobs: vi.fn(),
    archiveJobs: vi.fn().mockResolvedValue(opts.archived ?? 0),
    purgeArchivedJobs: vi.fn().mockResolvedValue(opts.purged ?? 0),
    countByStatus: vi
      .fn()
      .mockResolvedValue(
        opts.counts ?? { pending: 0, running: 0, completed: 0, failed: 0, archived: 0 },
      ),
  };
}

describe("parseMaintenanceFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseMaintenanceFlags({ args: [] });
    expect(r.errors).toEqual([]);
    expect(r.help).toBe(false);
    expect(r.options).toEqual({});
  });

  it("parses --apply", () => {
    expect(parseMaintenanceFlags({ args: ["--apply"] }).options.apply).toBe(true);
  });

  it("parses --archive-after with unit suffixes", () => {
    expect(parseMaintenanceFlags({ args: ["--archive-after", "30m"] }).options.archiveAfterMs).toBe(30 * 60_000);
    expect(parseMaintenanceFlags({ args: ["--archive-after", "2h"] }).options.archiveAfterMs).toBe(2 * 60 * 60_000);
    expect(parseMaintenanceFlags({ args: ["--archive-after", "1d"] }).options.archiveAfterMs).toBe(86_400_000);
    expect(parseMaintenanceFlags({ args: ["--archive-after", "45s"] }).options.archiveAfterMs).toBe(45_000);
    expect(parseMaintenanceFlags({ args: ["--archive-after", "100"] }).options.archiveAfterMs).toBe(100);
  });

  it("parses --purge-after and --limit together", () => {
    const r = parseMaintenanceFlags({
      args: ["--apply", "--purge-after", "30d", "--limit", "500"],
    });
    expect(r.errors).toEqual([]);
    expect(r.options).toEqual({
      apply: true,
      purgeAfterMs: 30 * 86_400_000,
      limit: 500,
    });
  });

  it("records -h / --help as a help request without other errors", () => {
    expect(parseMaintenanceFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseMaintenanceFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on unknown flags", () => {
    const r = parseMaintenanceFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });

  it("errors on bad duration / bad limit", () => {
    const r1 = parseMaintenanceFlags({ args: ["--archive-after", "abc"] });
    expect(r1.errors[0]).toMatch(/invalid duration/);
    const r2 = parseMaintenanceFlags({ args: ["--limit", "-1"] });
    expect(r2.errors[0]).toMatch(/invalid positive integer/);
    const r3 = parseMaintenanceFlags({ args: ["--purge-after", "5x"] });
    expect(r3.errors[0]).toMatch(/invalid duration/);
  });

  it("errors when a flag value is missing", () => {
    const r = parseMaintenanceFlags({ args: ["--archive-after"] });
    expect(r.errors[0]).toMatch(/invalid duration/);
  });
});

describe("runMaintenance", () => {
  it("dry-run by default: does NOT call archiveJobs or purgeArchivedJobs", async () => {
    const queue = makeFakeQueue({});
    const log = vi.fn();
    await runMaintenance({ queue, options: {}, log });

    expect(queue.archiveJobs).not.toHaveBeenCalled();
    expect(queue.purgeArchivedJobs).not.toHaveBeenCalled();
    expect(queue.countByStatus).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("dry-run: would archive completed/failed jobs"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("dry-run: would purge archived jobs"),
    );
  });

  it("--apply: runs archive then purge with the configured age + limit", async () => {
    const queue = makeFakeQueue({
      archived: 12,
      purged: 4,
      counts: { pending: 1, running: 0, completed: 0, failed: 0, archived: 4 },
    });
    const log = vi.fn();
    const result = await runMaintenance({
      queue,
      options: {
        apply: true,
        archiveAfterMs: 60_000,
        purgeAfterMs: 7 * 86_400_000,
        limit: 500,
      },
      log,
    });

    expect(queue.archiveJobs).toHaveBeenCalledWith({
      statuses: ["completed", "failed"],
      olderThanMs: 60_000,
      limit: 500,
    });
    expect(queue.purgeArchivedJobs).toHaveBeenCalledWith({
      olderThanMs: 7 * 86_400_000,
      limit: 500,
    });
    expect(result.archived).toBe(12);
    expect(result.purged).toBe(4);
    expect(result.byStatus.archived).toBe(4);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("archived 12"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("purged 4"));
  });

  it("--apply: shows before and after counts", async () => {
    const calls: { values: object }[] = [];
    const queue = makeFakeQueue({});
    queue.countByStatus = vi.fn().mockImplementation(async () => {
      calls.push({ values: {} });
      return calls.length === 1
        ? { pending: 5, running: 1, completed: 100, failed: 4, archived: 12 }
        : { pending: 6, running: 0, completed: 80, failed: 4, archived: 8 };
    });

    const log = vi.fn();
    await runMaintenance({ queue, options: { apply: true }, log });
    expect(queue.countByStatus).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^before: /));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^after:  /));
  });

  it("dry-run: shows only one countByStatus call (the 'before' snapshot)", async () => {
    const queue = makeFakeQueue({});
    await runMaintenance({ queue, options: {} });
    expect(queue.countByStatus).toHaveBeenCalledTimes(1);
  });

  it("defaults come from DEFAULT_MAINTENANCE_OPTIONS when not overridden", async () => {
    const queue = makeFakeQueue({ archived: 0, purged: 0 });
    await runMaintenance({ queue, options: { apply: true } });
    expect(DEFAULT_MAINTENANCE_OPTIONS.apply).toBe(false);
    expect(queue.archiveJobs).toHaveBeenCalledWith({
      statuses: ["completed", "failed"],
      olderThanMs: DEFAULT_MAINTENANCE_OPTIONS.archiveAfterMs,
      limit: DEFAULT_MAINTENANCE_OPTIONS.limit,
    });
    expect(queue.purgeArchivedJobs).toHaveBeenCalledWith({
      olderThanMs: DEFAULT_MAINTENANCE_OPTIONS.purgeAfterMs,
      limit: DEFAULT_MAINTENANCE_OPTIONS.limit,
    });
  });

  it("MAINTENANCE_HELP mentions --apply, both age flags, and the cron cadence", () => {
    expect(MAINTENANCE_HELP).toContain("--apply");
    expect(MAINTENANCE_HELP).toContain("--archive-after");
    expect(MAINTENANCE_HELP).toContain("--purge-after");
    expect(MAINTENANCE_HELP).toContain("cron");
  });
});
