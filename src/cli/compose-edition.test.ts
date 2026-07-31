import { describe, expect, it, vi } from "vitest";
import { parseComposeEditionFlags, runComposeEditionCommand } from "./compose-edition.js";

describe("compose-edition command", () => {
  it("parses its bounded date flag", () => {
    expect(parseComposeEditionFlags({ args: ["--date", "2026-07-31"] })).toMatchObject({ editionDate: "2026-07-31", errors: [] });
  });

  it("refuses immutable editions before composing", async () => {
    const compose = vi.fn();
    await expect(runComposeEditionCommand({
      editionDate: "2026-07-31",
      getEdition: async () => ({ id: "e", status: "published" }),
      compose,
    })).rejects.toThrow("immutable");
    expect(compose).not.toHaveBeenCalled();
  });
});
