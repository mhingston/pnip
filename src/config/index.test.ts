import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  parseYoutubeFocusChannels,
  resetConfigCache,
  type Config,
} from "./index.js";

describe("config", () => {
  const originalEnv: NodeJS.ProcessEnv = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it("throws when DATABASE_URL is missing/undefined", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is an empty string", () => {
    process.env.DATABASE_URL = "";
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL does not start with 'postgres'", () => {
    process.env.DATABASE_URL = "mysql://localhost/db";
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("returns a typed Config with DATABASE_URL and LOG_LEVEL defaulting to 'info'", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    delete process.env.LOG_LEVEL;
    const config: Config = loadConfig();
    expect(config.DATABASE_URL).toBe("postgres://localhost/db");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("caches the config instance; resetConfigCache yields a fresh instance", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    const first = loadConfig();
    const second = loadConfig();
    expect(second).toBe(first);
    resetConfigCache();
    const third = loadConfig();
    expect(third).not.toBe(first);
    expect(third.DATABASE_URL).toBe("postgres://localhost/db");
  });

  it("parses MARKITDOWN_BIN from env", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.MARKITDOWN_BIN = "/usr/bin/markitdown";
    const config = loadConfig();
    expect(config.MARKITDOWN_BIN).toBe("/usr/bin/markitdown");
  });

  it("DOCTOR_FAILED_THRESHOLD coerces a numeric string to a number", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DOCTOR_FAILED_THRESHOLD = "5";
    const config = loadConfig();
    expect(config.DOCTOR_FAILED_THRESHOLD).toBe(5);
  });

  it("DOCTOR_FAILED_THRESHOLD throws when set to a non-numeric value", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DOCTOR_FAILED_THRESHOLD = "abc";
    expect(() => loadConfig()).toThrow(/DOCTOR_FAILED_THRESHOLD/);
  });

  it("DOCTOR_FAILED_THRESHOLD throws when set to a non-positive integer", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DOCTOR_FAILED_THRESHOLD = "0";
    expect(() => loadConfig()).toThrow(/DOCTOR_FAILED_THRESHOLD/);
    process.env.DOCTOR_FAILED_THRESHOLD = "-3";
    expect(() => loadConfig({ force: true })).toThrow(
      /DOCTOR_FAILED_THRESHOLD/,
    );
  });

  it("DOCTOR_FAILED_THRESHOLD throws when set to a non-integer", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DOCTOR_FAILED_THRESHOLD = "1.5";
    expect(() => loadConfig()).toThrow(/DOCTOR_FAILED_THRESHOLD/);
  });

  it("DIGEST_BIAS_ENABLED accepts the literal strings 'true' and 'false'", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DIGEST_BIAS_ENABLED = "true";
    expect(loadConfig().DIGEST_BIAS_ENABLED).toBe("true");
    process.env.DIGEST_BIAS_ENABLED = "false";
    expect(loadConfig({ force: true }).DIGEST_BIAS_ENABLED).toBe("false");
  });

  it("DIGEST_BIAS_ENABLED throws when set to anything other than 'true'/'false'", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DIGEST_BIAS_ENABLED = "yes";
    expect(() => loadConfig()).toThrow(/DIGEST_BIAS_ENABLED/);
    process.env.DIGEST_BIAS_ENABLED = "1";
    expect(() => loadConfig({ force: true })).toThrow(/DIGEST_BIAS_ENABLED/);
  });

  it("parses optional digest presentation calibration", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DIGEST_TARGET_READING_MINUTES = "8";
    process.env.DIGEST_QUIET_EDITION_REASON = "low_significance";
    const config = loadConfig();
    expect(config.DIGEST_TARGET_READING_MINUTES).toBe(8);
    expect(config.DIGEST_QUIET_EDITION_REASON).toBe("low_significance");
  });

  it("rejects unsupported quiet-edition claims", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    process.env.DIGEST_QUIET_EDITION_REASON = "few_sources";
    expect(() => loadConfig()).toThrow(/DIGEST_QUIET_EDITION_REASON/);
  });

  it("parses and de-duplicates focused YouTube channel names", () => {
    expect(
      parseYoutubeFocusChannels(" AI Engineer, Better Stack,AI Engineer, "),
    ).toEqual(["AI Engineer", "Better Stack"]);
    expect(parseYoutubeFocusChannels(undefined)).toEqual([]);
  });
});
