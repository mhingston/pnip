import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import {
  PUBLISH_EDITION_HELP,
  buildPartitionBreakdown,
  parsePublishEditionFlags,
  runPublishEditionCommand,
  todayDate,
} from "./publish-edition.js";
import {
  PublicationGateFailedError,
  type CompletionReport,
  type PublicationService,
  type PublicationServiceResult,
} from "../publication/publication-service.js";
import type { Database, Edition } from "../database/kysely.js";
import type { PartitionConfig } from "../config/index.js";

function makeFakeService(
  impl: Partial<PublicationService> = {},
): PublicationService {
  return {
    publish: vi.fn(),
    publishForDate: vi.fn(),
    checkCompletion: vi.fn(),
    ...impl,
  };
}

interface FakeLookup {
  getByDate: ReturnType<typeof vi.fn>;
}

function makeFakeLookup(
  impl: { getByDate?: ReturnType<typeof vi.fn> } = {},
): FakeLookup {
  return {
    getByDate: impl.getByDate ?? vi.fn(),
  };
}

function makeFakeDb(
  counts: Record<string, number>,
): Kysely<Database> {
  const rows = Object.entries(counts).map(([partition_key, n]) => ({
    partition_key,
    n: n as number,
  }));
  const chain: Record<string, unknown> = {};
  chain["select"] = vi.fn().mockReturnValue(chain);
  chain["where"] = vi.fn().mockReturnValue(chain);
  chain["groupBy"] = vi.fn().mockReturnValue(chain);
  chain["execute"] = vi.fn().mockResolvedValue(rows);
  return { selectFrom: vi.fn().mockReturnValue(chain) } as unknown as Kysely<Database>;
}

function makeEdition(overrides: Partial<Edition> = {}): Edition {
  return {
    id: "ed-1",
    publication_date: new Date("2026-07-07T00:00:00Z"),
    status: "ready",
    created_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    partition_key: "master",
    ...overrides,
  };
}

function makeReadyCompletionReport(
  overrides: Partial<CompletionReport> = {},
): CompletionReport {
  return {
    markdownExists: true,
    markdownNonEmpty: true,
    emailSent: true,
    notebookReady: true,
    podcastReady: true,
    partitionNotebooks: [],
    missingArtifacts: [],
    ...overrides,
  };
}

function makePublishedResult(
  overrides: Partial<PublicationServiceResult> = {},
): PublicationServiceResult {
  return {
    edition: makeEdition({ status: "published" }),
    status: "published",
    alreadyExisted: false,
    cancelledJobCount: 7,
    completion: makeReadyCompletionReport(),
    ...overrides,
  };
}

describe("parsePublishEditionFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parsePublishEditionFlags({ args: [] });
    expect(r).toEqual({
      editionDate: undefined,
      dryRun: false,
      help: false,
      errors: [],
    });
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parsePublishEditionFlags({
      args: ["--date", "2026-07-07"],
    });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-07");
  });

  it("errors on invalid date format", () => {
    const r = parsePublishEditionFlags({
      args: ["--date", "07-07-2026"],
    });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing date value", () => {
    const r = parsePublishEditionFlags({ args: ["--date"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("parses --dry-run", () => {
    const r = parsePublishEditionFlags({ args: ["--dry-run"] });
    expect(r.dryRun).toBe(true);
  });

  it("records -h / --help", () => {
    expect(parsePublishEditionFlags({ args: ["-h"] }).help).toBe(true);
    expect(parsePublishEditionFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on unknown flags", () => {
    const r = parsePublishEditionFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });
});

describe("runPublishEditionCommand", () => {
  it("dry-run calls checkCompletion and skips publish/publishForDate; exits 0 when all four booleans true", async () => {
    const service = makeFakeService({
      checkCompletion: vi
        .fn()
        .mockResolvedValue(makeReadyCompletionReport()),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(service.checkCompletion).toHaveBeenCalledWith("ed-1");
    expect(service.publishForDate).not.toHaveBeenCalled();
    expect(service.publish).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("--dry-run OK"))).toBe(true);
    expect(logs.some((l) => l.includes("markdown=true"))).toBe(true);
    expect(logs.some((l) => l.includes("podcast=true"))).toBe(true);
  });

  it("dry-run does not block when the optional podcast is not ready", async () => {
    const service = makeFakeService({
      checkCompletion: vi.fn().mockResolvedValue(
        makeReadyCompletionReport({ podcastReady: false, missingArtifacts: [] }),
      ),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });

    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      dryRun: true,
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
  });

  it("dry-run exits 1 and logs each missing artifact when a gate check fails", async () => {
    const service = makeFakeService({
      checkCompletion: vi.fn().mockResolvedValue(
        makeReadyCompletionReport({
          emailSent: false,
          podcastReady: false,
          missingArtifacts: ["email not sent", "podcast not ready or no URL"],
        }),
      ),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("email not sent"))).toBe(true);
    expect(logs.some((l) => l.includes("podcast not ready or no URL"))).toBe(
      true,
    );
  });

  it("dry-run exits 1 with a clear 'no edition for date' message when the lookup returns undefined", async () => {
    const service = makeFakeService();
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(undefined),
    });
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2030-01-01",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("no edition"))).toBe(true);
    expect(logs.some((l) => l.includes("2030-01-01"))).toBe(true);
    expect(service.checkCompletion).not.toHaveBeenCalled();
  });

  it("dry-run with empty partition config: only master in breakdown; master status reflects completion", async () => {
    const service = makeFakeService({
      checkCompletion: vi
        .fn()
        .mockResolvedValue(makeReadyCompletionReport()),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const db = makeFakeDb({ master: 19 });
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      db,
      partitionConfig: {},
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(logs.some((l) => l.startsWith("  master:"))).toBe(true);
    expect(logs.some((l) => l.includes("notebook=ready"))).toBe(true);
    expect(logs.some((l) => l.startsWith("  youtube"))).toBe(false);
    expect(logs.some((l) => l.startsWith("  blogs"))).toBe(false);
  });

  it("dry-run with configured partition above threshold: shows configured partition with correct count", async () => {
    const service = makeFakeService({
      checkCompletion: vi.fn().mockResolvedValue(
        makeReadyCompletionReport({
          partitionNotebooks: [
            {
              partitionKey: "youtube",
              documentCount: 7,
              notebookReady: true,
              podcastRequired: false,
              podcastReady: true,
            },
          ],
        }),
      ),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const db = makeFakeDb({ master: 19, youtube: 7 });
    const config: PartitionConfig = {
      youtube: { min_articles: 5, enabled: true },
    };
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      db,
      partitionConfig: config,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    const ytLine = logs.find((l) => l.startsWith("  youtube:"));
    expect(ytLine).toBeDefined();
    expect(ytLine).toContain("7 docs");
    expect(ytLine).toContain("notebook=ready");
    expect(ytLine).not.toContain("skipped");
  });

  it("dry-run with partition below threshold: shows 'skipped (below min_articles=N)'", async () => {
    const service = makeFakeService({
      checkCompletion: vi
        .fn()
        .mockResolvedValue(makeReadyCompletionReport()),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const db = makeFakeDb({ master: 19, reddit: 1 });
    const config: PartitionConfig = {
      reddit: { min_articles: 5, enabled: true },
    };
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      db,
      partitionConfig: config,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    const redditLine = logs.find((l) => l.startsWith("  reddit:"));
    expect(redditLine).toBeDefined();
    expect(redditLine).toContain("1 docs");
    expect(redditLine).toContain("skipped (below min_articles=5)");
  });

  it("dry-run without db: still logs the master status line from completion", async () => {
    const service = makeFakeService({
      checkCompletion: vi
        .fn()
        .mockResolvedValue(makeReadyCompletionReport()),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const logs: string[] = [];
    await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((l) => l.startsWith("  master:"))).toBe(true);
  });

  it("dry-run fails gate when a partition notebook is pending", async () => {
    const service = makeFakeService({
      checkCompletion: vi.fn().mockResolvedValue(
        makeReadyCompletionReport({
          partitionNotebooks: [
            {
              partitionKey: "youtube",
              documentCount: 7,
              notebookReady: false,
              podcastRequired: false,
              podcastReady: true,
            },
          ],
          missingArtifacts: ["notebook not ready (partition youtube)"],
        }),
      ),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const db = makeFakeDb({ master: 19, youtube: 7 });
    const config: PartitionConfig = {
      youtube: { min_articles: 5, enabled: true },
    };
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      db,
      partitionConfig: config,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    const ytLine = logs.find((l) => l.startsWith("  youtube:"));
    expect(ytLine).toBeDefined();
    expect(ytLine).toContain("notebook=pending");
    expect(
      logs.some((l) =>
        l.includes("notebook not ready (partition youtube)"),
      ),
    ).toBe(true);
  });

  it("dry-run with podcast-required partition shows notebook AND podcast state", async () => {
    const service = makeFakeService({
      checkCompletion: vi.fn().mockResolvedValue(
        makeReadyCompletionReport({
          partitionNotebooks: [
            {
              partitionKey: "reddit",
              documentCount: 5,
              notebookReady: true,
              podcastRequired: true,
              podcastReady: true,
            },
          ],
        }),
      ),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    const db = makeFakeDb({ master: 19, reddit: 5 });
    const config: PartitionConfig = {
      reddit: { min_articles: 1, enabled: true, with_podcast: true },
    };
    const logs: string[] = [];
    await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      db,
      partitionConfig: config,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    const redditLine = logs.find((l) => l.startsWith("  reddit:"));
    expect(redditLine).toBeDefined();
    expect(redditLine).toContain("notebook=ready");
    expect(redditLine).toContain("podcast=ready");
  });

  it("real run calls publishForDate (NOT checkCompletion), logs the result, exits 0 on published", async () => {
    const service = makeFakeService({
      publishForDate: vi.fn().mockResolvedValue(makePublishedResult()),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(service.publishForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
    });
    expect(service.checkCompletion).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Edition ed-1"))).toBe(true);
    expect(logs.some((l) => l.includes("status=published"))).toBe(true);
    expect(logs.some((l) => l.includes("alreadyExisted=false"))).toBe(true);
  });

  it("real run exits 0 on already_published (idempotent) and logs alreadyExisted=true", async () => {
    const service = makeFakeService({
      publishForDate: vi.fn().mockResolvedValue(
        makePublishedResult({
          status: "already_published",
          alreadyExisted: true,
          cancelledJobCount: 0,
        }),
      ),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("status=already_published"))).toBe(true);
    expect(logs.some((l) => l.includes("alreadyExisted=true"))).toBe(true);
  });

  it("real run exits 0 on status=publishing (in-progress)", async () => {
    const service = makeFakeService({
      publishForDate: vi.fn().mockResolvedValue(
        makePublishedResult({
          status: "publishing",
          cancelledJobCount: 0,
          alreadyExisted: false,
        }),
      ),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("status=publishing"))).toBe(true);
  });

  it("real run exits 1 and logs missing artifacts when the service throws PublicationGateFailedError", async () => {
    const service = makeFakeService({
      publishForDate: vi
        .fn()
        .mockRejectedValue(
          new PublicationGateFailedError("ed-1", [
            "markdown digest missing or empty",
          ]),
        ),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("missing artifacts"))).toBe(true);
    expect(
      logs.some((l) => l.includes("markdown digest missing or empty")),
    ).toBe(true);
  });

  it("real run exits 1 and logs 'publish-edition failed' when the service throws a non-gate error", async () => {
    const service = makeFakeService({
      publishForDate: vi.fn().mockRejectedValue(new Error("kaboom")),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    const result = await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("publish-edition failed"))).toBe(true);
    expect(logs.some((l) => l.includes("kaboom"))).toBe(true);
  });

  it("uses todayDate() when no editionDate is provided (real run)", async () => {
    const service = makeFakeService({
      publishForDate: vi.fn().mockResolvedValue(makePublishedResult()),
    });
    const lookup = makeFakeLookup();
    await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      log: () => {},
    });
    expect(service.publishForDate).toHaveBeenCalledWith({
      editionDate: todayDate(),
    });
  });

  it("uses todayDate() when no editionDate is provided (dry-run)", async () => {
    const service = makeFakeService({
      checkCompletion: vi
        .fn()
        .mockResolvedValue(makeReadyCompletionReport()),
    });
    const lookup = makeFakeLookup({
      getByDate: vi.fn().mockResolvedValue(makeEdition()),
    });
    await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      dryRun: true,
      log: () => {},
    });
    expect(lookup.getByDate).toHaveBeenCalledWith(todayDate());
  });

  it("real-run log includes cancelledJobCount", async () => {
    const service = makeFakeService({
      publishForDate: vi
        .fn()
        .mockResolvedValue(makePublishedResult({ cancelledJobCount: 7 })),
    });
    const lookup = makeFakeLookup();
    const logs: string[] = [];
    await runPublishEditionCommand({
      service,
      editionLookup: lookup,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((l) => l.includes("cancelledJobCount=7"))).toBe(true);
  });
});

describe("PUBLISH_EDITION_HELP", () => {
  it("includes the command name and the --date, --dry-run, --help flags", () => {
    expect(PUBLISH_EDITION_HELP).toContain("digestive publish-edition");
    expect(PUBLISH_EDITION_HELP).toContain("--date");
    expect(PUBLISH_EDITION_HELP).toContain("--dry-run");
    expect(PUBLISH_EDITION_HELP).toContain("--help");
  });
});

describe("buildPartitionBreakdown", () => {
  it("with empty config returns just the master entry", async () => {
    const db = makeFakeDb({ master: 19 });
    const breakdown = await buildPartitionBreakdown({
      db,
      editionId: "ed-1",
      config: {},
      completion: makeReadyCompletionReport(),
    });
    expect(breakdown).toEqual([
      {
        partitionKey: "master",
        documentCount: 19,
        active: true,
        minArticles: 0,
        enabled: true,
        notebookReady: true,
        podcastRequired: true,
        podcastReady: true,
      },
    ]);
  });

  it("marks configured partition as inactive when below min_articles", async () => {
    const db = makeFakeDb({ master: 19, reddit: 1 });
    const breakdown = await buildPartitionBreakdown({
      db,
      editionId: "ed-1",
      config: { reddit: { min_articles: 5, enabled: true } },
      completion: makeReadyCompletionReport(),
    });
    const reddit = breakdown.find((b) => b.partitionKey === "reddit");
    const master = breakdown.find((b) => b.partitionKey === "master");
    expect(master?.documentCount).toBe(20);
    expect(reddit).toBeDefined();
    expect(reddit?.active).toBe(false);
    expect(reddit?.documentCount).toBe(1);
    expect(reddit?.minArticles).toBe(5);
    expect(reddit?.notebookReady).toBeNull();
  });

  it("propagates partitionNotebook readiness into the breakdown entry", async () => {
    const db = makeFakeDb({ master: 19, youtube: 7 });
    const completion = makeReadyCompletionReport({
      partitionNotebooks: [
        {
          partitionKey: "youtube",
          documentCount: 7,
          notebookReady: true,
          podcastRequired: false,
          podcastReady: true,
        },
      ],
    });
    const breakdown = await buildPartitionBreakdown({
      db,
      editionId: "ed-1",
      config: { youtube: { min_articles: 5, enabled: true } },
      completion,
    });
    const yt = breakdown.find((b) => b.partitionKey === "youtube");
    const master = breakdown.find((b) => b.partitionKey === "master");
    expect(master?.documentCount).toBe(26);
    expect(yt?.active).toBe(true);
    expect(yt?.notebookReady).toBe(true);
    expect(yt?.podcastRequired).toBe(false);
  });
});
