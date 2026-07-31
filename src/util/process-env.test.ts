import { describe, expect, it } from "vitest";
import { envWithHomeLocalBin } from "./process-env.js";

describe("envWithHomeLocalBin", () => {
  it("prepends $HOME/.local/bin to PATH", () => {
    const out = envWithHomeLocalBin({ HOME: "/home/mark", PATH: "/usr/bin:/bin" });
    expect(out.PATH).toBe("/home/mark/.local/bin:/usr/bin:/bin");
  });

  it("deduplicates when $HOME/.local/bin is already on PATH", () => {
    const out = envWithHomeLocalBin({
      HOME: "/home/mark",
      PATH: "/home/mark/.local/bin:/usr/bin:/bin",
    });
    expect(out.PATH).toBe("/home/mark/.local/bin:/usr/bin:/bin");
  });

  it("moves $HOME/.local/bin to the front even if it appears later", () => {
    const out = envWithHomeLocalBin({
      HOME: "/home/mark",
      PATH: "/usr/bin:/home/mark/.local/bin:/bin",
    });
    expect(out.PATH).toBe("/home/mark/.local/bin:/usr/bin:/bin");
  });

  it("passes PATH through when HOME is unset", () => {
    const out = envWithHomeLocalBin({ PATH: "/usr/bin:/bin" });
    expect(out.PATH).toBe("/usr/bin:/bin");
  });

  it("preserves other env vars from the base record", () => {
    const out = envWithHomeLocalBin({
      HOME: "/home/mark",
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://x",
    });
    expect(out.DATABASE_URL).toBe("postgres://x");
    expect(out.HOME).toBe("/home/mark");
  });
});
