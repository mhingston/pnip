/**
 * Bridges the PNIP publish step to the standalone pnip-raindrop-bridge
 * CLI. After an edition is published, this emitter writes a JSON entry to
 * a temp file and invokes the configured bridge command, which appends it
 * to the bridge's unbookmark queue.
 *
 * The split between file-write and process-spawn is deliberate: callers
 * can swap the spawner for tests (or for in-process invocation during
 * dev) without touching the queue contract.
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface UnbookmarkEntry {
  editionId: string;
  editionDate: string;
  bridgeTokens: string[];
  queuedAt: string;
}

export interface SpawnLike {
  (command: string, args: readonly string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: "pipe" | "inherit";
  }): Promise<{ status: number; stdout: string; stderr: string }>;
}

export interface UnbookmarkEmitter {
  /** Write the entry to a temp file and hand it to the bridge CLI. */
  emit(entry: UnbookmarkEntry): Promise<{ filePath: string; status: number }>;
}

export interface CreateUnbookmarkEmitterDeps {
  /** Command string passed to a POSIX shell, e.g. "npm run bridge -- enqueue". */
  command: string;
  /** Working directory for the spawned process; defaults to the bridge checkout. */
  cwd?: string;
  /** Override the spawner for tests. Defaults to a shell-based spawn. */
  spawn?: SpawnLike;
  /** Override the temp directory. Defaults to os.tmpdir(). */
  tempDir?: string;
}

const DEFAULT_TEMP_PREFIX = "pnip-unbookmark-";

export function createUnbookmarkEmitter(
  deps: CreateUnbookmarkEmitterDeps,
): UnbookmarkEmitter {
  if (!deps.command || deps.command.trim() === "") {
    throw new Error("UnbookmarkEmitter: command is required");
  }
  const cwd = deps.cwd ?? process.cwd();
  const spawnImpl: SpawnLike = deps.spawn ?? defaultSpawn;
  const tempDir = deps.tempDir ?? tmpdir();

  return {
    async emit(entry) {
      const dir = mkdtempSync(join(tempDir, DEFAULT_TEMP_PREFIX));
      const filePath = join(dir, "entry.json");
      writeFileSync(filePath, JSON.stringify(entry));
      const args = [...tokenize(deps.command), filePath];
      const head = args[0]!;
      const tail = args.slice(1);
      const result = await spawnImpl(head, tail, {
        cwd,
        env: process.env,
        stdio: "pipe",
      });
      return { filePath, status: result.status };
    },
  };
}

/**
 * Tokenize a command string the way a POSIX shell would, honoring single
 * and double quotes. We don't want to drag in a real shell dependency
 * just to split an arg list, and node:child_process.spawn requires the
 * caller to do the splitting.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === null) {
      if (c === " " || c === "\t" || c === "\n") {
        if (buf.length > 0) {
          tokens.push(buf);
          buf = "";
        }
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === quote) {
      quote = null;
      continue;
    }
    if (c === "\\" && quote === '"') {
      const next = command[i + 1];
      if (next !== undefined) {
        buf += next;
        i++;
      }
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

async function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: "pipe" | "inherit" },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ status: code ?? 0, stdout, stderr });
    });
  });
}
