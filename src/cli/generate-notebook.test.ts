import { describe, it, expect, vi } from "vitest";
import {
  GENERATE_NOTEBOOK_HELP,
  parseGenerateNotebookFlags,
  runGenerateNotebookCommand,
  todayDate,
} from "./generate-notebook.js";
import type {
  NotebookService,
  NotebookServiceResult,
} from "../digest/notebooklm/notebook-service.js";
import type { Edition } from "../database/kysely.js";

function makeFakeService(impl: Partial<NotebookService> = {}): NotebookService {
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

function makeReadyResult(overrides: Partial<NotebookServiceResult> = {}): NotebookServiceResult {
  return {
    notebookId: "nb-row-1",
    edition: makeEdition(),
    notebookExternalId: "nb-ext-1",
    url: "https://notebooklm.google.com/notebook/nb-ext-1",
    sourceCount: 3,
    status: "ready",
    alreadyExisted: false,
    failureReason: null,
    skipReason: null,
    mode: "wait",
    partitionKey: "master",
    ...overrides,
  };
}

describe("parseGenerateNotebookFlags", () => {
  it("returns defaults when no flags passed", () => {
    const r = parseGenerateNotebookFlags({ args: [] });
    expect(r).toEqual({
      editionDate: undefined,
      partitionKey: undefined,
      wait: false,
      help: false,
      errors: [],
    });
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parseGenerateNotebookFlags({ args: ["--date", "2026-07-07"] });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-07");
  });

  it("parses --wait", () => {
    const r = parseGenerateNotebookFlags({ args: ["--wait"] });
    expect(r.wait).toBe(true);
  });

  it("parses --partition", () => {
    const r = parseGenerateNotebookFlags({
      args: ["--partition", "youtube"],
    });
    expect(r.errors).toEqual([]);
    expect(r.partitionKey).toBe("youtube");
  });

  it("records -h / --help", () => {
    expect(parseGenerateNotebookFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseGenerateNotebookFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on invalid date format", () => {
    const r = parseGenerateNotebookFlags({ args: ["--date", "07-07-2026"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing date value", () => {
    const r = parseGenerateNotebookFlags({ args: ["--date"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing partition value", () => {
    const r = parseGenerateNotebookFlags({ args: ["--partition"] });
    expect(r.errors[0]).toMatch(/missing value/);
  });

  it("errors on unknown flags", () => {
    const r = parseGenerateNotebookFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });
});

describe("runGenerateNotebookCommand", () => {
  it("returns exitCode 0 and calls generateForDate with the provided date", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(makeReadyResult()),
    });
    const logs: string[] = [];
    const result = await runGenerateNotebookCommand({
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
    expect(logs.some((l) => l.includes("nb-row-1") && l.includes("2026-07-07"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("sources=3"))).toBe(true);
    expect(logs.some((l) => l.includes("status=ready"))).toBe(true);
  });

  it("uses todayDate() when no date is provided", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(makeReadyResult()),
    });
    await runGenerateNotebookCommand({ service });
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
    await runGenerateNotebookCommand({
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
    await runGenerateNotebookCommand({
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

  it("logs the skip reason when the service returns status 'skipped'", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue(
        makeReadyResult({
          status: "skipped",
          notebookId: "",
          notebookExternalId: "",
          url: "",
          sourceCount: 2,
          skipReason:
            "partition 'youtube' has 2 uploadable documents, below threshold 5",
        }),
      ),
    });
    const logs: string[] = [];
    const result = await runGenerateNotebookCommand({
      service,
      editionDate: "2026-07-07",
      partitionKey: "youtube",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(
      logs.some((l) =>
        l.includes("partition 'youtube' has 2 uploadable documents"),
      ),
    ).toBe(true);
  });

  it("returns exitCode 1 and logs the error on a thrown error", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    const result = await runGenerateNotebookCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("boom") || l.includes("failed"))).toBe(
      true,
    );
  });

  it("returns exitCode 0 and shows alreadyExisted=true on the second call", async () => {
    const service = makeFakeService({
      generateForDate: vi
        .fn()
        .mockResolvedValue(
          makeReadyResult({ alreadyExisted: true, sourceCount: 3 }),
        ),
    });
    const logs: string[] = [];
    const result = await runGenerateNotebookCommand({
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
          failureReason: "source 'X' (src-1) failed to ingest",
          sourceCount: 1,
        }),
      ),
    });
    const logs: string[] = [];
    const result = await runGenerateNotebookCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(
      logs.some((l) => l.includes("source 'X' (src-1) failed to ingest")),
    ).toBe(true);
  });
});

describe("GENERATE_NOTEBOOK_HELP", () => {
  it("includes the command name and the --date flag", () => {
    expect(GENERATE_NOTEBOOK_HELP).toContain("digestive generate-notebook");
    expect(GENERATE_NOTEBOOK_HELP).toContain("--date");
    expect(GENERATE_NOTEBOOK_HELP).toContain("--partition");
  });
});