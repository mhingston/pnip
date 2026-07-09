import { describe, it, expect, vi } from "vitest";
import {
  GENERATE_PODCAST_HELP,
  parseGeneratePodcastFlags,
  runGeneratePodcastCommand,
  todayDate,
} from "./generate-podcast.js";
import type {
  PodcastService,
  PodcastServiceResult,
} from "../digest/notebooklm/podcast-service.js";
import type { Edition } from "../database/kysely.js";

function makeFakeService(
  impl: Partial<PodcastService> = {},
): PodcastService {
  return {
    generate: vi.fn(),
    generateForDate: vi.fn(),
    ...impl,
  };
}

function makeEdition(): Edition {
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
  };
}

function makeReadyResult(
  overrides: Partial<PodcastServiceResult> = {},
): PodcastServiceResult {
  return {
    podcastId: "pod-row-1",
    edition: makeEdition(),
    artifactExternalId: "artifact-1",
    url: "https://cdn.example.com/podcast.mp3",
    localPath: "/tmp/notebooks/ed-1.mp3",
    durationSeconds: 1200,
    status: "ready",
    alreadyExisted: false,
    failureReason: null,
    partitionKey: "master",
    ...overrides,
  };
}

describe("parseGeneratePodcastFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseGeneratePodcastFlags({ args: [] });
    expect(r).toEqual({
      editionDate: undefined,
      partitionKey: undefined,
      wait: false,
      help: false,
      errors: [],
    });
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parseGeneratePodcastFlags({
      args: ["--date", "2026-07-07"],
    });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-07");
  });

  it("parses --wait", () => {
    const r = parseGeneratePodcastFlags({ args: ["--wait"] });
    expect(r.wait).toBe(true);
  });

  it("parses --partition", () => {
    const r = parseGeneratePodcastFlags({
      args: ["--partition", "youtube"],
    });
    expect(r.errors).toEqual([]);
    expect(r.partitionKey).toBe("youtube");
  });

  it("records -h / --help", () => {
    expect(parseGeneratePodcastFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseGeneratePodcastFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on invalid date format", () => {
    const r = parseGeneratePodcastFlags({
      args: ["--date", "07-07-2026"],
    });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing date value", () => {
    const r = parseGeneratePodcastFlags({ args: ["--date"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing partition value", () => {
    const r = parseGeneratePodcastFlags({ args: ["--partition"] });
    expect(r.errors[0]).toMatch(/missing value/);
  });

  it("errors on unknown flags", () => {
    const r = parseGeneratePodcastFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });
});

describe("runGeneratePodcastCommand", () => {
  it("returns exitCode 0 and calls generateForDate with the provided date", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(makeReadyResult()),
    });
    const logs: string[] = [];
    const result = await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
      partitionKey: "master",
      wait: undefined,
    });
    expect(
      logs.some(
        (l) => l.includes("pod-row-1") && l.includes("2026-07-07"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("status=ready"))).toBe(true);
    expect(logs.some((l) => l.includes("alreadyExisted=false"))).toBe(true);
    expect(
      logs.some((l) => l.includes("durationSeconds=1200")),
    ).toBe(true);
  });

  it("uses todayDate() when no date is provided", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(makeReadyResult()),
    });
    await runGeneratePodcastCommand({ service });
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: todayDate(),
      partitionKey: "master",
      wait: undefined,
    });
  });

  it("defaults partitionKey to 'master' when not provided", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(makeReadyResult()),
    });
    await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
    });
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
      partitionKey: "master",
      wait: undefined,
    });
  });

  it("passes --partition flag through to the service", async () => {
    const service = makeFakeService({
      generateForDate: vi
        .fn()
        .mockResolvedValue(
          makeReadyResult({ partitionKey: "youtube" }),
        ),
    });
    const logs: string[] = [];
    await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      partitionKey: "youtube",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
      partitionKey: "youtube",
      wait: undefined,
    });
    expect(logs.some((l) => l.includes("partition=youtube"))).toBe(true);
  });

  it("returns exitCode 1 and logs the error on a thrown error", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    const result = await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(
      logs.some((l) => l.includes("boom") || l.includes("failed")),
    ).toBe(true);
  });

  it("returns exitCode 0 and shows alreadyExisted=true on the second call", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(
        makeReadyResult({
          alreadyExisted: true,
          localPath: "/tmp/notebooks/ed-1.mp3",
        }),
      ),
    });
    const logs: string[] = [];
    const result = await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("alreadyExisted=true"))).toBe(true);
  });

  it("returns exitCode 1 and logs the failureReason when status is 'failed'", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(
        makeReadyResult({
          status: "failed",
          failureReason: "audio generation failed",
          url: null,
          localPath: null,
        }),
      ),
    });
    const logs: string[] = [];
    const result = await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(
      logs.some((l) => l.includes("audio generation failed")),
    ).toBe(true);
  });

  it("returns exitCode 0 when the service returns status 'skipped'", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(
        makeReadyResult({
          status: "skipped",
          failureReason: null,
        }),
      ),
    });
    const logs: string[] = [];
    const result = await runGeneratePodcastCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("GENERATE_PODCAST_HELP", () => {
  it("includes the command name and the --date flag", () => {
    expect(GENERATE_PODCAST_HELP).toContain("digestive generate-podcast");
    expect(GENERATE_PODCAST_HELP).toContain("--date");
    expect(GENERATE_PODCAST_HELP).toContain("--partition");
  });
});