import { describe, it, expect } from "vitest";
import { parseCommand } from "./args.js";

describe("parseCommand", () => {
  it("extracts discover command from argv", () => {
    const result = parseCommand(["node", "digestive", "discover"]);
    expect(result).toEqual({ command: "discover", rest: [] });
  });

  it("separates flags into rest", () => {
    const result = parseCommand(["node", "digestive", "discover", "--date", "2026-01-01"]);
    expect(result).toEqual({ command: "discover", rest: ["--date", "2026-01-01"] });
  });

  it("returns undefined command when no command given", () => {
    const result = parseCommand(["node", "digestive"]);
    expect(result).toEqual({ command: undefined, rest: [] });
  });
});
