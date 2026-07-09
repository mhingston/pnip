import { describe, it, expect, vi } from "vitest";
import {
  GENERATE_EDITION_HELP,
  parseGenerateEditionFlags,
  runGenerateEditionCommand,
  type GenerateEditionCommandDeps,
} from "./generate-edition.js";
import type { Edition } from "../database/kysely.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { EditionReadinessGate } from "../editions/edition-readiness-gate.js";

function makeFakeEditionRepo(edition?: Edition): EditionRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    getByDate: vi.fn().mockResolvedValue(edition),
    getOrCreateForDate: vi.fn(),
    transition: vi.fn(),
    isProcessingAllowed: vi.fn(),
    assertProcessingAllowed: vi.fn(),
  };
}

function makeFakeGate(result: {
  transitioned: boolean;
  reason: string;
  edition: Edition;
}): EditionReadinessGate {
  return {
    transitionToReadyIfReady: vi.fn().mockResolvedValue(result),
  };
}

function makeEdition(overrides?: Partial<Edition>): Edition {
  return {
    id: "edition-1",
    publication_date: new Date("2026-07-07"),
    status: "building",
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

describe("parseGenerateEditionFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseGenerateEditionFlags({ args: [] });
    expect(r.errors).toEqual([]);
    expect(r.help).toBe(false);
    expect(r.editionDate).toBeUndefined();
  });

  it("parses --date with YYYY-MM-DD", () => {
    const r = parseGenerateEditionFlags({ args: ["--date", "2026-07-07"] });
    expect(r.errors).toEqual([]);
    expect(r.editionDate).toBe("2026-07-07");
  });

  it("rejects --date with an invalid format", () => {
    const r = parseGenerateEditionFlags({ args: ["--date", "07-07-2026"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("recognizes -h and --help", () => {
    expect(parseGenerateEditionFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseGenerateEditionFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("reports unknown flags", () => {
    const r = parseGenerateEditionFlags({ args: ["--bogus"] });
    expect(r.errors).toEqual(["unknown flag: --bogus"]);
  });
});

describe("runGenerateEditionCommand", () => {
  it("throws when no edition exists for the date", async () => {
    const deps: GenerateEditionCommandDeps = {
      editionRepo: makeFakeEditionRepo(undefined),
      readinessGate: makeFakeGate({
        transitioned: false,
        reason: "noop",
        edition: makeEdition(),
      }),
      editionDate: "2026-07-07",
    };

    await expect(runGenerateEditionCommand(deps)).rejects.toThrow(
      /no edition found for date/,
    );
  });

  it("transitions a building edition to ready and exits 0", async () => {
    const edition = makeEdition({ id: "e1", status: "building" });
    const ready = makeEdition({ id: "e1", status: "ready" });
    const logs: string[] = [];
    const r = await runGenerateEditionCommand({
      editionRepo: makeFakeEditionRepo(edition),
      readinessGate: makeFakeGate({ transitioned: true, reason: "ready", edition: ready }),
      editionDate: "2026-07-07",
      log: (m) => logs.push(m),
    });

    expect(r.exitCode).toBe(0);
    expect(r.editionId).toBe("e1");
    expect(r.transitioned).toBe(true);
    expect(r.status).toBe("ready");
    expect(logs.some((l) => l.includes("status=ready"))).toBe(true);
    expect(logs.some((l) => l.includes("transitioned=true"))).toBe(true);
  });

  it("building edition that stays building (gate did not transition) still exits 0", async () => {
    const edition = makeEdition({ id: "e1", status: "building" });
    const logs: string[] = [];
    const r = await runGenerateEditionCommand({
      editionRepo: makeFakeEditionRepo(edition),
      readinessGate: makeFakeGate({
        transitioned: false,
        reason: "missing chunks",
        edition: makeEdition({ id: "e1", status: "building" }),
      }),
      editionDate: "2026-07-07",
      log: (m) => logs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.transitioned).toBe(false);
    expect(r.status).toBe("building");
  });

  it("ready edition (idempotent re-run): exit 0, transitioned=false", async () => {
    const edition = makeEdition({ id: "e1", status: "ready" });
    const r = await runGenerateEditionCommand({
      editionRepo: makeFakeEditionRepo(edition),
      readinessGate: makeFakeGate({
        transitioned: false,
        reason: "already ready",
        edition,
      }),
      editionDate: "2026-07-07",
    });
    expect(r.exitCode).toBe(0);
    expect(r.transitioned).toBe(false);
    expect(r.status).toBe("ready");
  });

  it("failed edition: exit 1, status=failed", async () => {
    const edition = makeEdition({ id: "e1", status: "building" });
    const failed = makeEdition({ id: "e1", status: "failed" });
    const r = await runGenerateEditionCommand({
      editionRepo: makeFakeEditionRepo(edition),
      readinessGate: makeFakeGate({ transitioned: true, reason: "force-fail", edition: failed }),
      editionDate: "2026-07-07",
    });
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe("failed");
  });

  it("resolves by default date when editionDate is omitted", async () => {
    const edition = makeEdition({ id: "e-today", status: "ready" });
    const r = await runGenerateEditionCommand({
      editionRepo: makeFakeEditionRepo(edition),
      readinessGate: makeFakeGate({
        transitioned: false,
        reason: "already ready",
        edition,
      }),
    });
    expect(r.editionId).toBe("e-today");
  });

  it("GENERATE_EDITION_HELP mentions --date and exit codes", () => {
    expect(GENERATE_EDITION_HELP).toContain("--date");
    expect(GENERATE_EDITION_HELP).toContain("0");
    expect(GENERATE_EDITION_HELP).toContain("1");
  });
});