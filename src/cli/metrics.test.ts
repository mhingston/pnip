import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  METRICS_HELP,
  parseMetricsFlags,
  runMetricsCommand,
  type MetricsCommandDeps,
} from "./metrics.js";
import type { QueueMetrics } from "../jobs/queue/processing-job-queue.js";
import type { EditionMetrics } from "../editions/edition-metrics.js";
import { getEditionMetrics } from "../editions/edition-metrics.js";

vi.mock("../editions/edition-metrics.js", () => ({
  getEditionMetrics: vi.fn(),
}));

const mockedGetEditionMetrics = vi.mocked(getEditionMetrics);

function makeFakeQueue(metrics: QueueMetrics): {
  queue: MetricsCommandDeps["queue"];
  getMetrics: ReturnType<typeof vi.fn>;
} {
  const getMetrics = vi.fn().mockResolvedValue(metrics);
  return {
    queue: {
      enqueue: vi.fn(),
      claim: vi.fn(),
      complete: vi.fn(),
      getJob: vi.fn(),
      recoverStaleJobs: vi.fn(),
      cancelForEdition: vi.fn(),
      archiveJobs: vi.fn(),
      purgeArchivedJobs: vi.fn(),
      countByStatus: vi.fn(),
      listFailed: vi.fn(),
      requeue: vi.fn(),
      getMetrics,
    },
    getMetrics,
  };
}

const baseQueueMetrics: QueueMetrics = {
  byStatus: { pending: 2, running: 1, completed: 10, failed: 0, archived: 3 },
  totalCompleted: 10,
  totalFailed: 0,
  totalRetries: 4,
  maxRetries: 2,
  avgProcessingLatencyMs: 1234.5,
  throughputLastHour: 5,
  throughputLastDay: 9,
  oldestPendingAgeMs: 60000,
};

const baseEditionMetrics: EditionMetrics = {
  total: 6,
  byStatus: {
    published: 3,
    building: 1,
    ready: 1,
    publishing: 0,
    failed: 1,
  },
  publishedCount: 3,
  avgPublicationDurationMs: 9876.5,
  lastPublishedAt: new Date("2026-07-07T08:00:00.000Z"),
  oldestBuildingAgeMs: 120000,
};

describe("parseMetricsFlags", () => {
  it("returns help=false and no errors on empty args", () => {
    const r = parseMetricsFlags({ args: [] });
    expect(r.help).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it("records -h and --help as help requests", () => {
    expect(parseMetricsFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseMetricsFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on unknown flags", () => {
    const r = parseMetricsFlags({ args: ["--bogus"] });
    expect(r.errors).toEqual(["unknown flag: --bogus"]);
    expect(r.help).toBe(false);
  });
});

describe("runMetricsCommand", () => {
  beforeEach(() => {
    mockedGetEditionMetrics.mockReset();
    mockedGetEditionMetrics.mockResolvedValue(baseEditionMetrics);
  });

  it("calls queue.getMetrics and returns exitCode 0 with both metric payloads", async () => {
    const { queue, getMetrics } = makeFakeQueue(baseQueueMetrics);
    const deps: MetricsCommandDeps = {
      db: {} as never,
      queue,
      log: vi.fn(),
    };

    const result = await runMetricsCommand(deps);

    expect(getMetrics).toHaveBeenCalledTimes(1);
    expect(mockedGetEditionMetrics).toHaveBeenCalledTimes(1);
    expect(mockedGetEditionMetrics).toHaveBeenCalledWith(deps.db);
    expect(result.exitCode).toBe(0);
    expect(result.queue).toBe(baseQueueMetrics);
    expect(result.editions).toBe(baseEditionMetrics);
  });

  it("logs exactly four summary lines starting with queue:/editions:", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };

    await runMetricsCommand(deps);

    expect(log).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenNthCalledWith(1, expect.stringMatching(/^queue: /));
    expect(log).toHaveBeenNthCalledWith(2, expect.stringMatching(/^queue: /));
    expect(log).toHaveBeenNthCalledWith(3, expect.stringMatching(/^editions: /));
    expect(log).toHaveBeenNthCalledWith(4, expect.stringMatching(/^editions: /));
  });

  it("queue line 1 includes pending/running/completed/failed/archived from byStatus", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };

    await runMetricsCommand(deps);
    const first = log.mock.calls[0]![0] as string;
    expect(first).toContain("pending=2");
    expect(first).toContain("running=1");
    expect(first).toContain("completed=10");
    expect(first).toContain("failed=0");
    expect(first).toContain("archived=3");
  });

  it("queue line 2 includes totalRetries, maxRetries, avgLatencyMs, throughput, oldestPendingAgeMs", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };

    await runMetricsCommand(deps);
    const second = log.mock.calls[1]![0] as string;
    expect(second).toContain("totalRetries=4");
    expect(second).toContain("maxRetries=2");
    expect(second).toContain("avgLatencyMs=1234.5");
    expect(second).toContain("throughputLastHour=5");
    expect(second).toContain("throughputLastDay=9");
    expect(second).toContain("oldestPendingAgeMs=60000");
  });

  it("editions line 1 includes total and per-status counts from byStatus", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };

    await runMetricsCommand(deps);
    const third = log.mock.calls[2]![0] as string;
    expect(third).toContain("total=6");
    expect(third).toContain("published=3");
    expect(third).toContain("building=1");
    expect(third).toContain("ready=1");
    expect(third).toContain("publishing=0");
    expect(third).toContain("failed=1");
  });

  it("editions line 2 renders avg duration, lastPublishedAt ISO, and oldest building age; uses 'null' for missing values", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };
    mockedGetEditionMetrics.mockResolvedValueOnce({
      total: 0,
      byStatus: {},
      publishedCount: 0,
      avgPublicationDurationMs: null,
      lastPublishedAt: null,
      oldestBuildingAgeMs: null,
    });

    await runMetricsCommand(deps);
    const fourth = log.mock.calls[3]![0] as string;
    expect(fourth).toContain("avgPublicationDurationMs=null");
    expect(fourth).toContain("lastPublishedAt=null");
    expect(fourth).toContain("oldestBuildingAgeMs=null");
  });

  it("editions line 2 formats lastPublishedAt as ISO string when present", async () => {
    const { queue } = makeFakeQueue(baseQueueMetrics);
    const log = vi.fn();
    const deps: MetricsCommandDeps = { db: {} as never, queue, log };

    await runMetricsCommand(deps);
    const fourth = log.mock.calls[3]![0] as string;
    expect(fourth).toContain("lastPublishedAt=2026-07-07T08:00:00.000Z");
  });

  it("METRICS_HELP mentions §58 internal metrics, the -h/--help flag, and the read-only guarantee", () => {
    expect(METRICS_HELP).toContain("§58");
    expect(METRICS_HELP).toContain("--help");
    expect(METRICS_HELP).toMatch(/read-only/i);
  });
});
