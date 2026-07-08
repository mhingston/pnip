import { describe, it, expect, vi } from "vitest";
import {
  runSourceTrustCommand,
  SOURCE_TRUST_HELP,
  type SourceTrustCommandDeps,
} from "./source-trust.js";
import type {
  SourceTrustRepository,
  SourceTrustRow,
} from "../signals/source-trust-repository.js";

function makeRow(
  sourceIdentity: string,
  tier: number,
  notes: string | null = null,
): SourceTrustRow {
  return {
    source_identity: sourceIdentity,
    tier,
    notes,
    created_at: new Date("2026-07-08T00:00:00Z"),
    updated_at: new Date("2026-07-08T00:00:00Z"),
  };
}

function makeFakeRepo(opts: {
  rows?: Map<string, SourceTrustRow>;
}): SourceTrustRepository & { setMock: ReturnType<typeof vi.fn>; getMock: ReturnType<typeof vi.fn>; getAllMock: ReturnType<typeof vi.fn>; deleteMock: ReturnType<typeof vi.fn> } {
  const rows = opts.rows ?? new Map<string, SourceTrustRow>();
  const setMock = vi.fn(async (identity: string, tier: number, notes?: string | null) => {
    const row = makeRow(identity, tier, notes ?? null);
    rows.set(identity, row);
    return row;
  });
  const getMock = vi.fn(async (identity: string) => rows.get(identity));
  const getAllMock = vi.fn(async () =>
    Array.from(rows.values()).sort((a, b) =>
      a.source_identity.localeCompare(b.source_identity),
    ),
  );
  const deleteMock = vi.fn(async (identity: string) => {
    rows.delete(identity);
  });
  return {
    set: setMock,
    get: getMock,
    getAll: getAllMock,
    delete: deleteMock,
    setMock,
    getMock,
    getAllMock,
    deleteMock,
  };
}

function makeDeps(
  args: string[],
  repo: SourceTrustRepository,
  log?: (m: string) => void,
): SourceTrustCommandDeps {
  return { repo, args, log };
}

describe("runSourceTrustCommand", () => {
  it("set <source_identity> <tier> upserts a row and exits 0", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["set", "theverge.com", "2"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    expect(repo.setMock).toHaveBeenCalledWith("theverge.com", 2, null);
    expect(logs.some((l) => l.includes("theverge.com") && l.includes("tier=2"))).toBe(true);
  });

  it("set --notes passes notes through to the repo", async () => {
    const repo = makeFakeRepo({});
    const r = await runSourceTrustCommand(
      makeDeps(["set", "theverge.com", "1", "--notes", "core source"], repo),
    );
    expect(r.exitCode).toBe(0);
    expect(repo.setMock).toHaveBeenCalledWith("theverge.com", 1, "core source");
  });

  it("set rejects a non-integer tier with exit code 2", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["set", "theverge.com", "abc"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(2);
    expect(repo.setMock).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("1-5"))).toBe(true);
  });

  it("set rejects a tier outside 1-5 (0 and 6) with exit code 2", async () => {
    const repo = makeFakeRepo({});
    expect(
      (await runSourceTrustCommand(makeDeps(["set", "a.com", "0"], repo))).exitCode,
    ).toBe(2);
    expect(repo.setMock).not.toHaveBeenCalled();
    expect(
      (await runSourceTrustCommand(makeDeps(["set", "a.com", "6"], repo))).exitCode,
    ).toBe(2);
    expect(repo.setMock).not.toHaveBeenCalled();
  });

  it("set with missing positional args exits 2", async () => {
    const repo = makeFakeRepo({});
    const r = await runSourceTrustCommand(makeDeps(["set", "only-one"], repo));
    expect(r.exitCode).toBe(2);
    expect(repo.setMock).not.toHaveBeenCalled();
  });

  it("get prints the row for an existing source and exits 0", async () => {
    const repo = makeFakeRepo({
      rows: new Map([["theverge.com", makeRow("theverge.com", 2, "ok")]]),
    });
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["get", "theverge.com"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("theverge.com") && l.includes("2"))).toBe(true);
  });

  it("get for a missing source exits 1", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["get", "nope.com"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("no source_trust row"))).toBe(true);
  });

  it("list prints all rows sorted by source_identity and exits 0", async () => {
    const repo = makeFakeRepo({
      rows: new Map([
        ["zeta.com", makeRow("zeta.com", 4)],
        ["alpha.com", makeRow("alpha.com", 1, "first")],
      ]),
    });
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["list"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    const printed = logs.filter((l) => !l.startsWith("digestive") && !l.startsWith("("));
    expect(printed[0]).toContain("alpha.com");
    expect(printed[1]).toContain("zeta.com");
  });

  it("list with no rows reports an empty state and exits 0", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["list"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("no source_trust rows"))).toBe(true);
  });

  it("delete removes an existing row and exits 0", async () => {
    const repo = makeFakeRepo({
      rows: new Map([["gone.com", makeRow("gone.com", 5)]]),
    });
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["delete", "gone.com"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    expect(repo.deleteMock).toHaveBeenCalledWith("gone.com");
    expect(logs.some((l) => l.includes("deleted gone.com"))).toBe(true);
  });

  it("delete for a missing source exits 1 without calling delete", async () => {
    const repo = makeFakeRepo({});
    const r = await runSourceTrustCommand(makeDeps(["delete", "nope.com"], repo));
    expect(r.exitCode).toBe(1);
    expect(repo.deleteMock).not.toHaveBeenCalled();
  });

  it("--help prints help and exits 0", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["--help"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(0);
    expect(logs[0]).toBe(SOURCE_TRUST_HELP);
  });

  it("no args prints help and exits 2", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(makeDeps([], repo, (m) => logs.push(m)));
    expect(r.exitCode).toBe(2);
    expect(logs[0]).toBe(SOURCE_TRUST_HELP);
  });

  it("unknown subcommand exits 2", async () => {
    const repo = makeFakeRepo({});
    const logs: string[] = [];
    const r = await runSourceTrustCommand(
      makeDeps(["frobnicate"], repo, (m) => logs.push(m)),
    );
    expect(r.exitCode).toBe(2);
    expect(logs.some((l) => l.includes("unknown subcommand"))).toBe(true);
  });
});
