import { describe, it, expect, vi } from "vitest";
import {
  PUBLISH_EDITION_HELP,
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
import type { Edition } from "../database/kysely.js";

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