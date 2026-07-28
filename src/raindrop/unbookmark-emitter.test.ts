import { describe, expect, it, vi } from "vitest";
import {
  createUnbookmarkEmitter,
  tokenize,
  type SpawnLike,
  type UnbookmarkEntry,
} from "./unbookmark-emitter.js";

const sampleEntry: UnbookmarkEntry = {
  editionId: "11111111-1111-1111-1111-111111111111",
  editionDate: "2025-07-27",
  bridgeTokens: ["1", "2", "3"],
  queuedAt: "2025-07-27T18:00:00.000Z",
};

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("npm run bridge -- enqueue")).toEqual(["npm", "run", "bridge", "--", "enqueue"]);
  });

  it("honors double quotes", () => {
    expect(tokenize('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("honors single quotes", () => {
    expect(tokenize("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("treats backslashes as literal inside single quotes", () => {
    expect(tokenize("echo 'a\\b'")).toEqual(["echo", "a\\b"]);
  });
});

describe("createUnbookmarkEmitter", () => {
  it("rejects an empty command", () => {
    expect(() => createUnbookmarkEmitter({ command: "" })).toThrow(/command is required/);
  });

  it("writes the entry to a temp file and invokes the configured command with the file path", async () => {
    const spawn = vi.fn<SpawnLike>(async () => ({ status: 0, stdout: "ok", stderr: "" }));
    const tempDir = "/tmp";
    const emitter = createUnbookmarkEmitter({
      command: "npm run bridge -- enqueue",
      spawn,
      tempDir,
    });
    const result = await emitter.emit(sampleEntry);
    expect(result.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [head, tail] = spawn.mock.calls[0]!;
    expect(head).toBe("npm");
    expect(tail).toEqual(["run", "bridge", "--", "enqueue", result.filePath]);
    expect(result.filePath).toMatch(/pnip-unbookmark-/);
    expect(result.filePath).toContain("entry.json");
  });

  it("surfaces non-zero exit codes to the caller without throwing", async () => {
    const spawn = vi.fn<SpawnLike>(async () => ({ status: 1, stdout: "", stderr: "boom" }));
    const emitter = createUnbookmarkEmitter({ command: "npm run bridge -- enqueue", spawn, tempDir: "/tmp" });
    const result = await emitter.emit(sampleEntry);
    expect(result.status).toBe(1);
  });
});
