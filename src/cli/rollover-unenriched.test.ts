import { describe, expect, it, vi } from "vitest";
import {
  ROLLOVER_UNENRICHED_HELP,
  parseRolloverUnenrichedFlags,
  runRolloverUnenrichedCommand,
  todayDate,
} from "./rollover-unenriched.js";
import type { EditionRolloverService } from "../editions/edition-rollover-service.js";

function makeFakeService(
  impl: Partial<EditionRolloverService>,
): EditionRolloverService {
  return {
    rolloverUnreadyDocuments: vi.fn(),
    ...impl,
  } as EditionRolloverService;
}

describe("parseRolloverUnenrichedFlags", () => {
  it("returns defaults when no flags passed", () => {
    expect(parseRolloverUnenrichedFlags({ args: [] })).toEqual({
      editionDate: undefined,
      help: false,
      errors: [],
    });
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parseRolloverUnenrichedFlags({ args: ["--date", "2026-07-23"] });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-23");
  });

  it("records -h / --help", () => {
    expect(parseRolloverUnenrichedFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseRolloverUnenrichedFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on invalid date format", () => {
    const r = parseRolloverUnenrichedFlags({ args: ["--date", "07-07-2026"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on missing date value", () => {
    const r = parseRolloverUnenrichedFlags({ args: ["--date"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on unknown flags", () => {
    const r = parseRolloverUnenrichedFlags({ args: ["--nope"] });
    expect(r.errors).toEqual(["unknown flag: --nope"]);
  });
});

describe("runRolloverUnenrichedCommand", () => {
  it("resolves the edition by date and logs the rollover outcome", async () => {
    const service = makeFakeService({
      rolloverUnreadyDocuments: vi.fn().mockResolvedValue({
        sourceEditionId: "src-1",
        targetEditionId: "tgt-1",
        movedDocumentCount: 16,
        movedDiscoveryEventCount: 12,
        movedJobCount: 80,
        requeuedJobCount: 4,
        cancelledJobCount: 0,
        deletedStoryIds: [],
      }),
    });
    const logs: string[] = [];
    const result = await runRolloverUnenrichedCommand({
      service,
      resolveEditionId: async (date) => (date === "2026-07-23" ? "src-1" : undefined),
      editionDate: "2026-07-23",
      log: (m) => logs.push(m),
    });
    expect(result.exitCode).toBe(0);
    expect(service.rolloverUnreadyDocuments).toHaveBeenCalledWith("src-1");
    expect(logs.some((l) => l.includes("moved 16 documents"))).toBe(true);
    expect(logs.some((l) => l.includes("src-1"))).toBe(true);
  });

  it("returns exit 1 with a clear message when the edition does not exist", async () => {
    const service = makeFakeService({
      rolloverUnreadyDocuments: vi.fn(),
    });
    const logs: string[] = [];
    const result = await runRolloverUnenrichedCommand({
      service,
      resolveEditionId: async () => undefined,
      editionDate: "2099-01-01",
      log: (m) => logs.push(m),
    });
    expect(result.exitCode).toBe(1);
    expect(service.rolloverUnreadyDocuments).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("no edition found"))).toBe(true);
  });

  it("propagates service errors as exit 1", async () => {
    const service = makeFakeService({
      rolloverUnreadyDocuments: vi.fn().mockRejectedValue(new Error("db exploded")),
    });
    const logs: string[] = [];
    const result = await runRolloverUnenrichedCommand({
      service,
      resolveEditionId: async () => "src-1",
      editionDate: "2026-07-23",
      log: (m) => logs.push(m),
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("db exploded"))).toBe(true);
  });

  it("defaults to today() when no date is provided", async () => {
    const service = makeFakeService({
      rolloverUnreadyDocuments: vi.fn().mockResolvedValue({
        sourceEditionId: "src-1",
        targetEditionId: "tgt-1",
        movedDocumentCount: 0,
        movedDiscoveryEventCount: 0,
        movedJobCount: 0,
        cancelledJobCount: 0,
        deletedStoryIds: [],
      }),
    });
    const result = await runRolloverUnenrichedCommand({
      service,
      resolveEditionId: async (date) => (date === todayDate() ? "src-1" : undefined),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(service.rolloverUnreadyDocuments).toHaveBeenCalledWith("src-1");
  });
});
