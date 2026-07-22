import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROCESS_MAX_JOBS,
  parseProcessFlags,
  PROCESS_HELP,
  resolveProcessMaxJobs,
} from "./process.js";

describe("parseProcessFlags", () => {
  it("returns defaults when no flags are passed", () => {
    expect(parseProcessFlags({ args: [] })).toEqual({
      editionDate: undefined,
      maxJobs: undefined,
      help: false,
      errors: [],
    });
  });

  it("parses an edition date and batch limit", () => {
    expect(
      parseProcessFlags({
        args: ["--date", "2026-07-16", "--max-jobs", "100"],
      }),
    ).toEqual({
      editionDate: "2026-07-16",
      maxJobs: 100,
      help: false,
      errors: [],
    });
  });

  it("rejects invalid values and unknown flags", () => {
    const result = parseProcessFlags({
      args: ["--date", "16-07-2026", "--max-jobs", "0", "--unknown"],
    });
    expect(result.errors).toEqual([
      '--date: invalid date "16-07-2026", expected YYYY-MM-DD',
      '--max-jobs: invalid value "0", expected a positive integer',
      "unknown flag: --unknown",
    ]);
  });

  it("recognizes help", () => {
    expect(parseProcessFlags({ args: ["--help"] }).help).toBe(true);
    expect(PROCESS_HELP).toContain("--max-jobs");
  });

  it("applies a safety cap when no explicit batch limit is supplied", () => {
    expect(resolveProcessMaxJobs(undefined)).toBe(DEFAULT_PROCESS_MAX_JOBS);
    expect(resolveProcessMaxJobs(250)).toBe(250);
  });
});
