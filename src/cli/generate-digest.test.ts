import { describe, it, expect, vi } from "vitest";
import {
  GENERATE_DIGEST_HELP,
  parseGenerateDigestFlags,
  runGenerateDigestCommand,
  todayDate,
} from "./generate-digest.js";
import type { MarkdownDigestService } from "../digest/markdown/markdown-digest-service.js";

function makeFakeService(
  impl: Partial<MarkdownDigestService>,
): MarkdownDigestService {
  return {
    generate: vi.fn(),
    generateForDate: vi.fn(),
    renderMarkdown: vi.fn(),
    collectStories: vi.fn(),
    categorizeStory: vi.fn(),
    ...impl,
  };
}

describe("parseGenerateDigestFlags", () => {
  it("returns defaults when no flags passed", () => {
    const r = parseGenerateDigestFlags({ args: [] });
    expect(r).toEqual({ editionDate: undefined, help: false, errors: [] });
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parseGenerateDigestFlags({ args: ["--date", "2026-07-07"] });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-07");
  });

  it("records -h / --help", () => {
    expect(parseGenerateDigestFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseGenerateDigestFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on invalid date format", () => {
    const r = parseGenerateDigestFlags({ args: ["--date", "07-07-2026"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing date value", () => {
    const r = parseGenerateDigestFlags({ args: ["--date"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on unknown flags", () => {
    const r = parseGenerateDigestFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });
});

describe("runGenerateDigestCommand", () => {
  it("returns exitCode 0 and calls generateForDate with the provided date", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue({
        digestId: "md-1",
        edition: {
          id: "ed-1",
          publication_date: new Date("2026-07-07"),
          status: "ready",
          created_at: new Date(),
          updated_at: new Date(),
          published_at: null,
          failed_at: null,
          failure_reason: null,
          cluster_stories_enqueued_at: null,
          metadata: null,
        },
        storyCount: 5,
        documentCount: 7,
        citationCount: 12,
        alreadyExisted: false,
      }),
    });
    const logs: string[] = [];
    const result = await runGenerateDigestCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
    });
    expect(logs.some((l) => l.includes("md-1") && l.includes("ed-1"))).toBe(true);
  });

  it("uses today() when no date is provided", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue({
        digestId: "md-2",
        edition: {
          id: "ed-2",
          publication_date: new Date(),
          status: "ready",
          created_at: new Date(),
          updated_at: new Date(),
          published_at: null,
          failed_at: null,
          failure_reason: null,
          cluster_stories_enqueued_at: null,
          metadata: null,
        },
        storyCount: 0,
        documentCount: 0,
        citationCount: 0,
        alreadyExisted: false,
      }),
    });
    await runGenerateDigestCommand({ service });
    expect(service.generateForDate).toHaveBeenCalledWith({
      editionDate: todayDate(),
    });
  });

  it("reports alreadyExisted=true in the log", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockResolvedValue({
        digestId: "md-x",
        edition: {
          id: "ed-x",
          publication_date: new Date(),
          status: "ready",
          created_at: new Date(),
          updated_at: new Date(),
          published_at: null,
          failed_at: null,
          failure_reason: null,
          cluster_stories_enqueued_at: null,
          metadata: null,
        },
        storyCount: 0,
        documentCount: 0,
        citationCount: 0,
        alreadyExisted: true,
      }),
    });
    const logs: string[] = [];
    await runGenerateDigestCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((l) => l.includes("alreadyExisted=true"))).toBe(true);
  });

  it("returns exitCode 1 and logs the error on failure", async () => {
    const service = makeFakeService({
      generateForDate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    const result = await runGenerateDigestCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("boom") || l.includes("failed"))).toBe(true);
  });
});

describe("GENERATE_DIGEST_HELP", () => {
  it("renders the section listing without throwing", () => {
    expect(GENERATE_DIGEST_HELP).toContain("digestive generate-digest");
    expect(GENERATE_DIGEST_HELP).toContain("--date");
  });
});
