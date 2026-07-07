import { describe, it, expect, vi } from "vitest";
import {
  RETRY_HELP,
  parseRetryFlags,
  runRetryCommand,
  type RetryCommandDeps,
  type RetryFilters,
} from "./retry.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";

function makeFakeQueue(opts: {
  list?: ProcessingJob[];
  requeue?: number;
  listError?: Error;
  requeueError?: Error;
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
    countByStatus: vi.fn(),
    listFailed: opts.listError
      ? vi.fn().mockRejectedValue(opts.listError)
      : vi.fn().mockResolvedValue(opts.list ?? []),
    requeue: opts.requeueError
      ? vi.fn().mockRejectedValue(opts.requeueError)
      : vi.fn().mockResolvedValue(opts.requeue ?? 0),
  };
}

function fakeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: overrides?.id ?? "job-1",
    job_type: overrides?.job_type ?? "expand_document",
    edition_id: overrides?.edition_id ?? "e1",
    target: null,
    status: "failed",
    retry_count: 0,
    last_error: overrides?.last_error ?? { type: "X", message: "boom" },
    last_attempt_at: null,
    next_eligible_at: new Date(),
    locked_by: null,
    locked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    depends_on: [],
  };
}

describe("parseRetryFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseRetryFlags({ args: [] });
    expect(r.errors).toEqual([]);
    expect(r.help).toBe(false);
    expect(r.dryRun).toBe(false);
    expect(r.filters).toEqual({});
  });

  it("parses --edition-id when given a valid UUID", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const r = parseRetryFlags({ args: ["--edition-id", uuid] });
    expect(r.errors).toEqual([]);
    expect(r.filters.editionId).toBe(uuid);
  });

  it("rejects --edition-id with an invalid UUID", () => {
    const r = parseRetryFlags({ args: ["--edition-id", "not-a-uuid"] });
    expect(r.errors[0]).toMatch(/invalid UUID/);
    expect(r.filters.editionId).toBeUndefined();
  });

  it("parses --worker with a job type", () => {
    const r = parseRetryFlags({ args: ["--worker", "expand_document"] });
    expect(r.errors).toEqual([]);
    expect(r.filters.jobType).toBe("expand_document");
  });

  it("--job-type is an alias for --worker", () => {
    const r = parseRetryFlags({ args: ["--job-type", "embed_chunk"] });
    expect(r.errors).toEqual([]);
    expect(r.filters.jobType).toBe("embed_chunk");
  });

  it("rejects --worker when missing value", () => {
    const r = parseRetryFlags({ args: ["--worker"] });
    expect(r.errors[0]).toMatch(/missing job type/);
  });

  it("parses --older-than with unit suffixes", () => {
    expect(parseRetryFlags({ args: ["--older-than", "30m"] }).filters.olderThanMs).toBe(30 * 60_000);
    expect(parseRetryFlags({ args: ["--older-than", "2h"] }).filters.olderThanMs).toBe(2 * 60 * 60_000);
    expect(parseRetryFlags({ args: ["--older-than", "1d"] }).filters.olderThanMs).toBe(86_400_000);
    expect(parseRetryFlags({ args: ["--older-than", "45s"] }).filters.olderThanMs).toBe(45_000);
    expect(parseRetryFlags({ args: ["--older-than", "100"] }).filters.olderThanMs).toBe(100);
  });

  it("rejects --older-than with an invalid duration", () => {
    const r = parseRetryFlags({ args: ["--older-than", "abc"] });
    expect(r.errors[0]).toMatch(/invalid duration/);
  });

  it("parses --limit and caps to 10_000", () => {
    const r = parseRetryFlags({ args: ["--limit", "500"] });
    expect(r.errors).toEqual([]);
    expect(r.filters.limit).toBe(500);
    const big = parseRetryFlags({ args: ["--limit", "9999999"] });
    expect(big.filters.limit).toBe(10_000);
  });

  it("rejects --limit with a non-positive integer", () => {
    const r = parseRetryFlags({ args: ["--limit", "-1"] });
    expect(r.errors[0]).toMatch(/invalid positive integer/);
  });

  it("parses --dry-run", () => {
    const r = parseRetryFlags({ args: ["--dry-run"] });
    expect(r.errors).toEqual([]);
    expect(r.dryRun).toBe(true);
  });

  it("recognizes -h and --help without errors", () => {
    expect(parseRetryFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseRetryFlags({ args: ["--help"] }).help).toBe(true);
    expect(parseRetryFlags({ args: ["-h"] }).errors).toEqual([]);
  });

  it("reports unknown flags", () => {
    const r = parseRetryFlags({ args: ["--bogus"] });
    expect(r.errors).toEqual(["unknown flag: --bogus"]);
  });
});

describe("runRetryCommand", () => {
  it("lists and requeues: returns listed + requeued counts and exits 0", async () => {
    const queue = makeFakeQueue({
      list: [
        fakeJob({ id: "j1" }),
        fakeJob({ id: "j2", job_type: "chunk_document" }),
      ],
      requeue: 2,
    });
    const logs: string[] = [];
    const deps: RetryCommandDeps = { queue, log: (m) => logs.push(m) };

    const r = await runRetryCommand(deps);

    expect(queue.listFailed).toHaveBeenCalledWith({ limit: 1000 });
    expect(queue.requeue).toHaveBeenCalledWith(["j1", "j2"]);
    expect(r.exitCode).toBe(0);
    expect(r.listed).toBe(2);
    expect(r.requeued).toBe(2);
    expect(logs.some((l) => l.includes("found 2 failed"))).toBe(true);
    expect(logs.some((l) => l.includes("requeued 2"))).toBe(true);
  });

  it("--dry-run: lists but does NOT call requeue, exit 0", async () => {
    const queue = makeFakeQueue({
      list: [fakeJob({ id: "j1" })],
      requeue: 0,
    });
    const logs: string[] = [];
    const r = await runRetryCommand({
      queue,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    expect(queue.listFailed).toHaveBeenCalled();
    expect(queue.requeue).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
    expect(r.listed).toBe(1);
    expect(r.requeued).toBeUndefined();
    expect(logs.some((l) => l.includes("dry-run"))).toBe(true);
  });

  it("no matching failed jobs: exit 0 with listed=0, requeued=0", async () => {
    const queue = makeFakeQueue({ list: [], requeue: 0 });
    const r = await runRetryCommand({ queue });
    expect(r.exitCode).toBe(0);
    expect(r.listed).toBe(0);
    expect(r.requeued).toBe(0);
  });

  it("passes filters through to listFailed and caps limit at 10_000", async () => {
    const queue = makeFakeQueue({ list: [] });
    const filters: Partial<RetryFilters> = {
      editionId: "11111111-2222-3333-4444-555555555555",
      jobType: "expand_document",
      olderThanMs: 60_000,
      limit: 99_999_999,
    };
    await runRetryCommand({ queue, filters });
    expect(queue.listFailed).toHaveBeenCalledWith({
      editionId: filters.editionId,
      jobType: "expand_document",
      olderThanMs: 60_000,
      limit: 10_000,
    });
  });

  it("only logs the first 10 listed jobs but requeues all", async () => {
    const list = Array.from({ length: 12 }, (_, i) => fakeJob({ id: `j${i}` }));
    const queue = makeFakeQueue({ list, requeue: 12 });
    const logs: string[] = [];
    await runRetryCommand({ queue, log: (m) => logs.push(m) });

    expect(logs.filter((l) => l.startsWith("  - j")).length).toBe(10);
    expect(logs.some((l) => l.includes("... and 2 more"))).toBe(true);
    expect(queue.requeue).toHaveBeenCalledWith(list.map((j) => j.id));
  });

  it("surfaces listFailed errors with exitCode 1 and no requeue call", async () => {
    const queue = makeFakeQueue({ listError: new Error("db down") });
    const logs: string[] = [];
    const r = await runRetryCommand({ queue, log: (m) => logs.push(m) });

    expect(r.exitCode).toBe(1);
    expect(r.listed).toBeUndefined();
    expect(queue.requeue).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("listFailed failed"))).toBe(true);
  });

  it("surfaces requeue errors with exitCode 1 (after successful list)", async () => {
    const queue = makeFakeQueue({
      list: [fakeJob({ id: "j1" })],
      requeueError: new Error("db down"),
    });
    const r = await runRetryCommand({ queue });
    expect(r.exitCode).toBe(1);
    expect(r.listed).toBe(1);
    expect(r.requeued).toBeUndefined();
  });

  it("summarizes last_error.message for each listed job", async () => {
    const queue = makeFakeQueue({
      list: [fakeJob({ id: "j1", last_error: { type: "X", message: "weird thing" } })],
      requeue: 1,
    });
    const logs: string[] = [];
    await runRetryCommand({ queue, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes("weird thing"))).toBe(true);
  });

  it("summarizes last_error without message by stringifying the object", async () => {
    const queue = makeFakeQueue({
      list: [fakeJob({ id: "j1", last_error: { type: "X", extra: "y" } })],
      requeue: 1,
    });
    const logs: string[] = [];
    await runRetryCommand({ queue, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes("j1"))).toBe(true);
  });

  it("RETRY_HELP mentions --dry-run, all filters, and the cron cadence hint", () => {
    expect(RETRY_HELP).toContain("--dry-run");
    expect(RETRY_HELP).toContain("--edition-id");
    expect(RETRY_HELP).toContain("--worker");
    expect(RETRY_HELP).toContain("--job-type");
    expect(RETRY_HELP).toContain("--older-than");
    expect(RETRY_HELP).toContain("--limit");
  });
});