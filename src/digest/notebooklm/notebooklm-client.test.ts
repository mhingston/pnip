import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNotebookLmClient,
  NotebookLmError,
  type SpawnRunner,
  type SpawnResult,
} from "./notebooklm-client.js";

interface SpawnCall {
  bin: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  stdinPayload?: string;
}

function okResult(stdout: unknown, overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    signal: null,
    stdout:
      typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    durationMs: 5,
    timedOut: false,
    ...overrides,
  };
}

function failingResult(
  exitCode: number,
  stderr = "",
  stdout = "",
  timedOut = false,
): SpawnResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    durationMs: 5,
    timedOut,
  };
}

function makeSpawnRunner(
  impl: (input: SpawnCall) => SpawnResult | Promise<SpawnResult>,
): { spawn: SpawnRunner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnRunner = vi.fn(async (input) => {
    calls.push(input);
    return await impl(input);
  }) as unknown as SpawnRunner;
  return { spawn, calls };
}

describe("notebooklm-client", () => {
  describe("createNotebook", () => {
    it("returns id, title, url, and createdAt from the CLI JSON", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({
          notebook: {
            id: "nb-1",
            title: "Research",
            url: "https://notebooklm.google.com/notebook/nb-1",
            created_at: "2026-07-01T00:00:00Z",
          },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.createNotebook({ title: "Research" });
      expect(result).toEqual({
        notebookExternalId: "nb-1",
        title: "Research",
        url: "https://notebooklm.google.com/notebook/nb-1",
        createdAt: "2026-07-01T00:00:00Z",
      });
      expect(calls[0].args).toEqual(["create", "Research", "--json"]);
      expect(calls[0].bin).toBe("notebooklm");
    });

    it("synthesizes the canonical notebook URL when the CLI omits url", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({
          notebook: { id: "abc-123", title: "T", created_at: null },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.createNotebook({ title: "T" });
      expect(result.url).toBe(
        "https://notebooklm.google.com/notebook/abc-123",
      );
      expect(result.createdAt).toBeNull();
    });

    it("throws NotebookLmError with stdout preserved when JSON is invalid", async () => {
      const raw = "not valid json {";
      const { spawn } = makeSpawnRunner(() => okResult(raw));
      const client = createNotebookLmClient({ spawn });
      try {
        await client.createNotebook({ title: "X" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotebookLmError);
        if (err instanceof NotebookLmError) {
          expect(err.stdout).toBe(raw);
          expect(err.exitCode).toBeNull();
          expect(err.command).toContain("notebooklm create");
          expect(err.command).toContain("X");
          expect(err.command).toContain("--json");
        }
      }
    });
  });

  describe("addSource", () => {
    it("passes the URL directly to `source add`", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({
          source: {
            id: "src-1",
            title: null,
            type: "web_page",
            url: "https://example.com",
            status: "processing",
          },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.addSource({
        notebookExternalId: "nb-1",
        url: "https://example.com",
      });
      expect(result.sourceExternalId).toBe("src-1");
      expect(result.kind).toBe("web_page");
      expect(result.url).toBe("https://example.com");
      expect(result.status).toBe("processing");
      expect(calls[0].args).toEqual([
        "source",
        "add",
        "https://example.com",
        "-n",
        "nb-1",
        "--json",
      ]);
    });

    it("writes markdown content to a temp file, uploads it, and cleans up", async () => {
      let capturedTempPath = "";
      const { spawn } = makeSpawnRunner(({ args }) => {
        capturedTempPath = args[2];
        return okResult({
          source: {
            id: "src-2",
            title: "Md",
            type: "text",
            url: null,
            status: "processing",
          },
        });
      });
      const client = createNotebookLmClient({ spawn });
      const result = await client.addSource({
        notebookExternalId: "nb-1",
        markdownContent: "# Heading\n\nBody paragraph.\n",
      });
      expect(result.sourceExternalId).toBe("src-2");
      expect(capturedTempPath).toMatch(/\.md$/);
      expect(capturedTempPath).toMatch(
        /digestive-notebooklm-/,
      );
      const stillExists = await stat(capturedTempPath)
        .then(() => true)
        .catch(() => false);
      expect(stillExists).toBe(false);
    });

    it("passes filePath directly and forwards --title when displayName is provided", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({
          source: {
            id: "src-3",
            title: "Custom",
            type: "file",
            url: null,
            status: "ready",
          },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.addSource({
        notebookExternalId: "nb-1",
        filePath: "/srv/file.pdf",
        displayName: "Custom",
      });
      expect(result.sourceExternalId).toBe("src-3");
      expect(result.status).toBe("ready");
      expect(calls[0].args).toEqual([
        "source",
        "add",
        "/srv/file.pdf",
        "-n",
        "nb-1",
        "--title",
        "Custom",
        "--json",
      ]);
    });

    it("rejects when both url and markdownContent are supplied", async () => {
      const client = createNotebookLmClient({
        spawn: makeSpawnRunner(() => okResult({})).spawn,
      });
      await expect(
        client.addSource({
          notebookExternalId: "nb-1",
          url: "https://example.com",
          markdownContent: "x",
        }),
      ).rejects.toThrow(/only one/);
    });
  });

  describe("waitForSource", () => {
    it("returns 'ready' on exit 0", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({
          source: { id: "src-1", status: "ready" },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.waitForSource({
        notebookExternalId: "nb-1",
        sourceExternalId: "src-1",
      });
      expect(result.status).toBe("ready");
      expect(result.attempts).toBe(1);
      expect(calls[0].args).toContain("source");
      expect(calls[0].args).toContain("wait");
      expect(calls[0].args).toContain("src-1");
      expect(calls[0].args).toContain("--json");
    });

    it("returns 'timeout' on exit code 2", async () => {
      const { spawn } = makeSpawnRunner(() =>
        failingResult(2, "timeout exceeded"),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.waitForSource({
        notebookExternalId: "nb-1",
        sourceExternalId: "src-1",
        timeoutSec: 5,
      });
      expect(result.status).toBe("timeout");
      expect(result.attempts).toBe(0);
    });

    it("returns 'error' on other non-zero exits", async () => {
      const { spawn } = makeSpawnRunner(() =>
        failingResult(1, "source not found", "", false),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.waitForSource({
        notebookExternalId: "nb-1",
        sourceExternalId: "src-1",
        timeoutSec: 5,
      });
      expect(result.status).toBe("error");
      expect(result.attempts).toBe(0);
    });

    it("forwards pollIntervalMs as --interval seconds", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ source: { id: "src-1", status: "ready" } }),
      );
      const client = createNotebookLmClient({ spawn });
      await client.waitForSource({
        notebookExternalId: "nb-1",
        sourceExternalId: "src-1",
        timeoutSec: 5,
        pollIntervalMs: 3000,
      });
      expect(calls[0].args).toContain("--interval");
      expect(calls[0].args[calls[0].args.indexOf("--interval") + 1]).toBe("3");
    });
  });

  describe("generateAudio", () => {
    it("returns status=pending and url=null when not waiting", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ task_id: "task-1", status: "pending" }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.generateAudio({
        notebookExternalId: "nb-1",
        instructions: "Deep dive into the topic",
      });
      expect(result.taskId).toBe("task-1");
      expect(result.status).toBe("pending");
      expect(result.url).toBeNull();
      expect(calls[0].args).not.toContain("--wait");
      expect(calls[0].args).not.toContain("--wait");
      const i = calls[0].args.indexOf("--json");
      expect(i).toBe(calls[0].args.length - 1);
    });

    it("passes --wait and --timeout and surfaces the url on completion", async () => {
      const audioUrl = "https://notebooklm.google.com/audio/abc.mp3";
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({
          task_id: "task-2",
          status: "completed",
          url: audioUrl,
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.generateAudio({
        notebookExternalId: "nb-1",
        instructions: "Brief",
        format: "brief",
        length: "short",
        language: "en",
        wait: true,
        timeoutSec: 600,
      });
      expect(result.taskId).toBe("task-2");
      expect(result.status).toBe("completed");
      expect(result.url).toBe(audioUrl);
      expect(calls[0].args).toContain("--wait");
      expect(calls[0].args).toContain("--timeout");
      expect(calls[0].args).toContain("600");
      expect(calls[0].args).toContain("--format");
      const formatIdx = calls[0].args.indexOf("--format");
      expect(calls[0].args[formatIdx + 1]).toBe("brief");
      expect(calls[0].args).toContain("--length");
      const lengthIdx = calls[0].args.indexOf("--length");
      expect(calls[0].args[lengthIdx + 1]).toBe("short");
      expect(calls[0].args).toContain("--language");
      const langIdx = calls[0].args.indexOf("--language");
      expect(calls[0].args[langIdx + 1]).toBe("en");
      expect(calls[0].args).toContain("--json");
    });
  });

  describe("waitForArtifact", () => {
    it("returns 'completed' with url on a payload with status=completed", async () => {
      const audioUrl = "https://notebooklm.google.com/audio/xyz.mp3";
      const { spawn } = makeSpawnRunner(() =>
        okResult({ status: "completed", url: audioUrl }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.waitForArtifact({
        notebookExternalId: "nb-1",
        artifactExternalId: "art-1",
        timeoutSec: 60,
      });
      expect(result.status).toBe("completed");
      expect(result.url).toBe(audioUrl);
      expect(result.attempts).toBe(1);
    });

    it("returns 'timeout' on exit code 2", async () => {
      const { spawn } = makeSpawnRunner(() =>
        failingResult(2, "timeout", "", false),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.waitForArtifact({
        notebookExternalId: "nb-1",
        artifactExternalId: "art-1",
        timeoutSec: 5,
      });
      expect(result.status).toBe("timeout");
      expect(result.attempts).toBe(0);
    });
  });

  describe("downloadAudio", () => {
    it("parses destination path from JSON and verifies the file was written", async () => {
      const dir = await mkdtemp(join(tmpdir(), "digestive-notebooklm-dl-"));
      try {
        const destPath = join(dir, "audio.mp3");
        const { spawn, calls } = makeSpawnRenderer(async ({ args }) => {
          const audioIdx = args.indexOf("audio");
          const expected = args[audioIdx + 1];
          await writeFile(expected, "fake-mp3-data");
          return okResult({ path: expected, size: 13 });
        });
        const client = createNotebookLmClient({ spawn });
        const result = await client.downloadAudio({
          notebookExternalId: "nb-1",
          artifactExternalId: "art-1",
          destinationPath: destPath,
        });
        expect(result.destinationPath).toBe(destPath);
        expect(result.bytes).toBe(13);
        const stats = await stat(destPath);
        expect(stats.size).toBe(13);
        expect(calls[0].args).toContain("download");
        expect(calls[0].args).toContain("audio");
        expect(calls[0].args).toContain(destPath);
        expect(calls[0].args).toContain("-n");
        expect(calls[0].args).toContain("nb-1");
        expect(calls[0].args).toContain("-a");
        expect(calls[0].args).toContain("art-1");
        expect(calls[0].args).toContain("--json");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  describe("authCheck", () => {
    it("returns ok=true when status is 'ok' and checks.token_fetch is true", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({
          status: "ok",
          checks: {
            storage_exists: true,
            json_valid: true,
            cookies_present: true,
            sid_cookie: true,
            token_fetch: true,
          },
          details: { storage_path: "/srv/x" },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.authCheck();
      expect(result.ok).toBe(true);
      expect(callsContain(spawn, "auth check --test --json")).toBe(true);
    });

    it("returns ok=false when status is ok but token_fetch is not true", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({
          status: "ok",
          checks: { token_fetch: false },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.authCheck();
      expect(result.ok).toBe(false);
    });

    it("returns ok=false when token_fetch is true but status is not ok", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({
          status: "error",
          checks: { token_fetch: true },
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.authCheck();
      expect(result.ok).toBe(false);
    });

    it("returns ok=false with details when the CLI exits non-zero", async () => {
      const stderrJson = JSON.stringify({ status: "fail", reason: "no cookies" });
      const { spawn } = makeSpawnRunner(() =>
        failingResult(1, stderrJson),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.authCheck();
      expect(result.ok).toBe(false);
      expect(result.details).toEqual({
        status: "fail",
        reason: "no cookies",
      });
    });
  });

  describe("listNotebooks", () => {
    it("parses notebooks array into id/title/createdAt rows", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({
          notebooks: [
            {
              index: 1,
              id: "nb-1",
              title: "First",
              is_owner: true,
              created_at: "2026-07-01T00:00:00Z",
            },
            {
              index: 2,
              id: "nb-2",
              title: "Second",
              is_owner: true,
              created_at: null,
            },
          ],
          count: 2,
        }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.listNotebooks();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "nb-1",
        title: "First",
        createdAt: "2026-07-01T00:00:00Z",
      });
      expect(result[1]).toEqual({
        id: "nb-2",
        title: "Second",
        createdAt: null,
      });
    });

    it("returns an empty array when the CLI returns no notebooks", async () => {
      const { spawn } = makeSpawnRunner(() =>
        okResult({ notebooks: [], count: 0 }),
      );
      const client = createNotebookLmClient({ spawn });
      const result = await client.listNotebooks();
      expect(result).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("wraps non-zero exit in NotebookLmError with exitCode and stderr populated", async () => {
      const { spawn } = makeSpawnRunner(() =>
        failingResult(1, "auth missing", "{}", false),
      );
      const client = createNotebookLmClient({ spawn });
      try {
        await client.createNotebook({ title: "X" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotebookLmError);
        if (err instanceof NotebookLmError) {
          expect(err.exitCode).toBe(1);
          expect(err.stderr).toBe("auth missing");
          expect(err.stdout).toBe("{}");
          expect(err.timedOut).toBe(false);
          expect(err.command).toContain("notebooklm create");
        }
      }
    });

    it("wraps timedOut:true in NotebookLmError with exitCode=null and timedOut=true", async () => {
      const { spawn } = makeSpawnRunner(() =>
        failingResult(0, "still running", "partial output", true),
      );
      const client = createNotebookLmClient({ spawn });
      try {
        await client.createNotebook({ title: "T" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotebookLmError);
        if (err instanceof NotebookLmError) {
          expect(err.timedOut).toBe(true);
          expect(err.exitCode).toBeNull();
          expect(err.stderr).toBe("still running");
          expect(err.stdout).toBe("partial output");
        }
      }
    });

    it("throws NotebookLmError with stdout preserved on JSON parse failure", async () => {
      const raw = "garbage line that is not JSON";
      const { spawn } = makeSpawnRunner(() => okResult(raw));
      const client = createNotebookLmClient({ spawn });
      try {
        await client.createNotebook({ title: "X" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotebookLmError);
        if (err instanceof NotebookLmError) {
          expect(err.stdout).toBe(raw);
          expect(err.exitCode).toBeNull();
          expect(err.stderr).toBe("");
        }
      }
    });
  });

  describe("configuration", () => {
    it("exposes NOTEBOOKLM_PROFILE in env when profile is configured", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ notebook: { id: "nb-1", title: "T" } }),
      );
      const client = createNotebookLmClient({
        spawn,
        profile: "work",
      });
      await client.createNotebook({ title: "T" });
      expect(calls[0].env.NOTEBOOKLM_PROFILE).toBe("work");
    });

    it("exposes NOTEBOOKLM_STORAGE_PATH and NOTEBOOKLM_HOME when storage is configured", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ notebook: { id: "nb-1", title: "T" } }),
      );
      const client = createNotebookLmClient({
        spawn,
        storage: "/srv/notebooklm",
      });
      await client.createNotebook({ title: "T" });
      expect(calls[0].env.NOTEBOOKLM_STORAGE_PATH).toBe("/srv/notebooklm");
      expect(calls[0].env.NOTEBOOKLM_HOME).toBe("/srv/notebooklm");
    });

    it("uses a custom bin path when configured", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ notebook: { id: "nb-1", title: "T" } }),
      );
      const client = createNotebookLmClient({
        spawn,
        bin: "/opt/bin/notebooklm",
      });
      await client.createNotebook({ title: "T" });
      expect(calls[0].bin).toBe("/opt/bin/notebooklm");
    });

    it("lets defaultTimeoutMs pass through to spawn", async () => {
      const { spawn, calls } = makeSpawnRunner(() =>
        okResult({ notebook: { id: "nb-1", title: "T" } }),
      );
      const client = createNotebookLmClient({
        spawn,
        defaultTimeoutMs: 12_345,
      });
      await client.createNotebook({ title: "T" });
      expect(calls[0].timeoutMs).toBe(12_345);
    });
  });

  describe("default spawn integration", () => {
    it("exports a working factory that wires through default spawn", () => {
      expect(typeof createNotebookLmClient).toBe("function");
      const client = createNotebookLmClient({
        spawn: vi.fn(async () => okResult({ notebook: { id: "nb-x", title: "T" } })) as unknown as SpawnRunner,
      });
      expect(typeof client.createNotebook).toBe("function");
    });
  });
});

function makeSpawnRenderer(
  impl: (input: SpawnCall) => SpawnResult | Promise<SpawnResult>,
): { spawn: SpawnRunner; calls: SpawnCall[] } {
  return makeSpawnRunner(impl);
}

function callsContain(spawn: SpawnRunner, fragment: string): boolean {
  const fn = spawn as unknown as {
    mock: { calls: SpawnCall[][] };
  };
  const last = fn.mock.calls.at(-1)?.[0];
  if (!last) return false;
  return commandStringFor(last.bin, last.args).includes(fragment);
}

function commandStringFor(bin: string, args: string[]): string {
  return [bin, ...args].join(" ");
}
