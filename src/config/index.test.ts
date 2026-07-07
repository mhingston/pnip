import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfigCache, type Config } from "./index.js";

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
});
