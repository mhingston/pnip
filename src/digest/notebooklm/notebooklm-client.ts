import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logging/logger.js";

export class NotebookLmError extends Error {
  readonly name = "NotebookLmError";
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string | null;
  readonly command: string;
  readonly durationMs: number;
  readonly timedOut: boolean;

  constructor(input: {
    message: string;
    command: string;
    exitCode: number | null;
    stderr: string;
    stdout: string | null;
    durationMs: number;
    timedOut: boolean;
  }) {
    super(input.message);
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
    this.stdout = input.stdout;
    this.command = input.command;
    this.durationMs = input.durationMs;
    this.timedOut = input.timedOut;
    Object.setPrototypeOf(this, NotebookLmError.prototype);
  }
}

export interface CreateNotebookInput {
  title: string;
}

export interface CreateNotebookResult {
  notebookExternalId: string;
  title: string;
  url: string;
  createdAt: string | null;
}

export interface AddSourceInput {
  notebookExternalId: string;
  url?: string;
  filePath?: string;
  markdownContent?: string;
  displayName?: string;
}

export interface AddSourceResult {
  sourceExternalId: string;
  title: string | null;
  kind: string | null;
  url: string | null;
  status: string;
}

export type WaitSourceStatus = "ready" | "error" | "timeout";

export interface WaitSourceResult {
  status: WaitSourceStatus;
  attempts: number;
}

export interface GenerateAudioInput {
  notebookExternalId: string;
  instructions: string;
  format?: "deep-dive" | "brief" | "critique" | "debate";
  length?: "short" | "default" | "long";
  language?: string;
  wait?: boolean;
  timeoutSec?: number;
}

export interface GenerateAudioResult {
  taskId: string;
  status: "pending" | "completed";
  url: string | null;
}

export type WaitArtifactStatus = "completed" | "timeout";

export interface WaitArtifactResult {
  status: WaitArtifactStatus;
  url: string | null;
  attempts: number;
}

export interface DownloadAudioInput {
  notebookExternalId: string;
  artifactExternalId: string;
  destinationPath: string;
}

export interface DownloadAudioResult {
  destinationPath: string;
  bytes: number;
}

export interface NotebookLmClient {
  createNotebook(input: CreateNotebookInput): Promise<CreateNotebookResult>;
  addSource(input: AddSourceInput): Promise<AddSourceResult>;
  waitForSource(input: {
    notebookExternalId: string;
    sourceExternalId: string;
    timeoutSec?: number;
    pollIntervalMs?: number;
  }): Promise<WaitSourceResult>;
  generateAudio(input: GenerateAudioInput): Promise<GenerateAudioResult>;
  waitForArtifact(input: {
    notebookExternalId: string;
    artifactExternalId: string;
    timeoutSec?: number;
    pollIntervalMs?: number;
  }): Promise<WaitArtifactResult>;
  downloadAudio(input: DownloadAudioInput): Promise<DownloadAudioResult>;
  authCheck(): Promise<{ ok: boolean; details: unknown }>;
  listNotebooks(): Promise<Array<{ id: string; title: string; createdAt: string | null }>>;
}

export type SpawnRunner = (input: {
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdinPayload?: string;
  timeoutMs: number;
}) => Promise<SpawnResult>;

export interface SpawnResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface NotebookLmClientConfig {
  bin?: string;
  profile?: string;
  storage?: string;
  defaultTimeoutMs?: number;
  spawn?: SpawnRunner;
  logger?: Logger;
}

const DEFAULT_BIN = "notebooklm";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const NOTEBOOK_URL_PREFIX = "https://notebooklm.google.com/notebook/";
const SOURCE_WAIT_TIMEOUT_EXIT_CODE = 2;
const ARTIFACT_WAIT_TIMEOUT_EXIT_CODE = 2;
const SOURCE_WAIT_DEFAULT_TIMEOUT_SEC = 120;
const ARTIFACT_WAIT_DEFAULT_TIMEOUT_SEC = 300;
const GENERATE_WAIT_BUFFER_MS = 60_000;
const WAIT_BUFFER_MS = 30_000;

async function defaultSpawn(input: {
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdinPayload?: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timedOut = false;
    const child = spawn(input.bin, input.args, {
      env: input.env,
      stdio:
        input.stdinPayload !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* process may have just exited */
            }
          }, input.timeoutMs)
        : null;
    if (timer && typeof timer.unref === "function") timer.unref();

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    if (input.stdinPayload !== undefined && child.stdin) {
      const sink = child.stdin;
      sink.write(input.stdinPayload, "utf8", () => {
        sink.end();
      });
    }
  });
}

function quoteForDisplay(arg: string): string {
  return /[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

function commandStringFor(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteForDisplay).join(" ");
}

function envFromConfig(
  profile: string | undefined,
  storage: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (profile !== undefined) env.NOTEBOOKLM_PROFILE = profile;
  if (storage !== undefined) {
    env.NOTEBOOKLM_STORAGE_PATH = storage;
    env.NOTEBOOKLM_HOME = storage;
  }
  return env;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pollIntervalSeconds(pollIntervalMs: number | undefined): number | undefined {
  if (pollIntervalMs === undefined) return undefined;
  const seconds = Math.ceil(pollIntervalMs / 1000);
  return Math.max(1, seconds);
}

function resolveTimeoutMs(
  baseDefaultMs: number,
  ensureMinMs: number,
  overrideMs: number | undefined,
): number {
  const base = overrideMs ?? baseDefaultMs;
  return base >= ensureMinMs ? base : ensureMinMs;
}

function jsonError(input: {
  message: string;
  command: string;
  stdout: string;
  durationMs: number;
}): NotebookLmError {
  return new NotebookLmError({
    message: input.message,
    command: input.command,
    exitCode: null,
    stderr: "",
    stdout: input.stdout,
    durationMs: input.durationMs,
    timedOut: false,
  });
}

function requireStringField(
  obj: Record<string, unknown>,
  key: string,
  command: string,
  stdout: string,
  durationMs: number,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw jsonError({
      command,
      stdout,
      durationMs,
      message: `notebooklm CLI JSON missing required string field "${key}": ${command}`,
    });
  }
  return value;
}

function optionalStringField(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

export function createNotebookLmClient(
  config: NotebookLmClientConfig = {},
): NotebookLmClient {
  const bin = config.bin ?? DEFAULT_BIN;
  const spawnRunner = config.spawn ?? defaultSpawn;
  const logger = config.logger;
  const baseDefaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function runCli(
    args: string[],
    options: { stdinPayload?: string; timeoutMs?: number } = {},
  ): Promise<{ result: SpawnResult; command: string }> {
    const env = envFromConfig(config.profile, config.storage);
    const timeoutMs = options.timeoutMs ?? baseDefaultTimeoutMs;
    const command = commandStringFor(bin, args);
    let result: SpawnResult;
    try {
      const spawnInput: Parameters<SpawnRunner>[0] = {
        bin,
        args,
        env,
        timeoutMs,
      };
      if (options.stdinPayload !== undefined) {
        spawnInput.stdinPayload = options.stdinPayload;
      }
      result = await spawnRunner(spawnInput);
    } catch (err) {
      if (err instanceof NotebookLmError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new NotebookLmError({
        message: `notebooklm CLI failed to start: ${message}: ${command}`,
        command,
        exitCode: null,
        stderr: "",
        stdout: null,
        durationMs: 0,
        timedOut: false,
      });
    }
    if (result.timedOut) {
      logger?.error("notebooklm CLI timed out", {
        command,
        durationMs: result.durationMs,
      });
      throw new NotebookLmError({
        message: `notebooklm CLI timed out after ${timeoutMs}ms: ${command}`,
        command,
        exitCode: null,
        stderr: result.stderr,
        stdout: result.stdout,
        durationMs: result.durationMs,
        timedOut: true,
      });
    }
    if (result.exitCode !== 0) {
      throw new NotebookLmError({
        message: `notebooklm CLI exited with code ${result.exitCode}: ${command}`,
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        durationMs: result.durationMs,
        timedOut: false,
      });
    }
    return { result, command };
  }

  async function parseJsonObject(
    result: SpawnResult,
    command: string,
  ): Promise<Record<string, unknown>> {
    const stdout = result.stdout;
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw jsonError({
        command,
        stdout,
        durationMs: result.durationMs,
        message: `notebooklm CLI returned empty stdout: ${command}`,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw jsonError({
        command,
        stdout,
        durationMs: result.durationMs,
        message: `notebooklm CLI returned invalid JSON (${message}): ${command}`,
      });
    }
    if (!isPlainObject(parsed)) {
      throw jsonError({
        command,
        stdout,
        durationMs: result.durationMs,
        message: `notebooklm CLI returned non-object JSON: ${command}`,
      });
    }
    return parsed;
  }

  function parseTrailingJson(text: string | null | undefined): unknown {
    if (text === null || text === undefined) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }

  async function createNotebook(
    input: CreateNotebookInput,
  ): Promise<CreateNotebookResult> {
    const args = ["create", input.title, "--json"];
    const { result, command } = await runCli(args);
    const parsed = await parseJsonObject(result, command);
    const notebook = parsed.notebook;
    if (!isPlainObject(notebook)) {
      throw jsonError({
        command,
        stdout: result.stdout,
        durationMs: result.durationMs,
        message: `notebooklm CLI JSON missing required object field "notebook": ${command}`,
      });
    }
    const id = requireStringField(notebook, "id", command, result.stdout, result.durationMs);
    const title = requireStringField(
      notebook,
      "title",
      command,
      result.stdout,
      result.durationMs,
    );
    const createdAt = optionalStringField(notebook, "created_at");
    const url =
      optionalStringField(notebook, "url") ?? `${NOTEBOOK_URL_PREFIX}${id}`;
    return { notebookExternalId: id, title, url, createdAt };
  }

  async function addSource(input: AddSourceInput): Promise<AddSourceResult> {
    const filled = [input.url, input.filePath, input.markdownContent].filter(
      (v) => v !== undefined,
    ).length;
    if (filled === 0) {
      throw new Error(
        "addSource: one of url, filePath, or markdownContent is required",
      );
    }
    if (filled > 1) {
      throw new Error(
        "addSource: only one of url, filePath, or markdownContent may be provided",
      );
    }
    const displayName = input.displayName;

    // The CLI's `source add` accepts `--title TEXT` for text and uploaded-file
    // sources (verified against `notebooklm source add --help` on v0.7.3).
    // For URL sources the CLI ignores `--title` and uses the page title.
    async function invokeAdd(target: string): Promise<AddSourceResult> {
      const args = ["source", "add", target, "-n", input.notebookExternalId];
      if (displayName !== undefined) args.push("--title", displayName);
      args.push("--json");
      const { result, command } = await runCli(args);
      const parsed = await parseJsonObject(result, command);
      const source = parsed.source;
      if (!isPlainObject(source)) {
        throw jsonError({
          command,
          stdout: result.stdout,
          durationMs: result.durationMs,
          message: `notebooklm CLI JSON missing required object field "source": ${command}`,
        });
      }
      const id = requireStringField(
        source,
        "id",
        command,
        result.stdout,
        result.durationMs,
      );
      const title = optionalStringField(source, "title");
      const kind = optionalStringField(source, "type");
      const url = optionalStringField(source, "url");
      const rawStatus = source.status;
      const status = typeof rawStatus === "string" ? rawStatus : "processing";
      return { sourceExternalId: id, title, kind, url, status };
    }

    if (input.markdownContent !== undefined) {
      const dir = await mkdtemp(join(tmpdir(), "digestive-notebooklm-"));
      const tempPath = join(dir, `source-${randomUUID()}.md`);
      try {
        await writeFile(tempPath, input.markdownContent, "utf8");
        return await invokeAdd(tempPath);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const target = input.url ?? input.filePath;
    if (target === undefined) {
      throw new Error("addSource: unreachable — no target resolved");
    }
    return invokeAdd(target);
  }

  async function waitForSource(input: {
    notebookExternalId: string;
    sourceExternalId: string;
    timeoutSec?: number;
    pollIntervalMs?: number;
  }): Promise<WaitSourceResult> {
    const timeoutSec = input.timeoutSec ?? SOURCE_WAIT_DEFAULT_TIMEOUT_SEC;
    const intervalSec = pollIntervalSeconds(input.pollIntervalMs);
    const args = [
      "source",
      "wait",
      input.sourceExternalId,
      "-n",
      input.notebookExternalId,
      "--timeout",
      String(timeoutSec),
    ];
    if (intervalSec !== undefined) {
      args.push("--interval", String(intervalSec));
    }
    args.push("--json");
    const ensuredMs = resolveTimeoutMs(
      baseDefaultTimeoutMs,
      (timeoutSec + WAIT_BUFFER_MS / 1000) * 1000,
      undefined,
    );
    try {
      await runCli(args, { timeoutMs: ensuredMs });
      return { status: "ready", attempts: 1 };
    } catch (err) {
      if (err instanceof NotebookLmError) {
        if (err.exitCode === SOURCE_WAIT_TIMEOUT_EXIT_CODE) {
          return { status: "timeout", attempts: 0 };
        }
        if (err.exitCode !== null && err.exitCode !== 0) {
          return { status: "error", attempts: 0 };
        }
      }
      throw err;
    }
  }

  async function generateAudio(
    input: GenerateAudioInput,
  ): Promise<GenerateAudioResult> {
    const args = ["generate", "audio", input.instructions];
    if (input.format !== undefined) args.push("--format", input.format);
    if (input.length !== undefined) args.push("--length", input.length);
    if (input.language !== undefined) args.push("--language", input.language);
    args.push("-n", input.notebookExternalId);
    if (input.wait) {
      args.push("--wait");
      if (input.timeoutSec !== undefined) {
        args.push("--timeout", String(input.timeoutSec));
      }
    }
    args.push("--json");
    const ensureMinMs =
      input.wait && input.timeoutSec !== undefined
        ? input.timeoutSec * 1000 + GENERATE_WAIT_BUFFER_MS
        : 0;
    const timeoutMs = resolveTimeoutMs(baseDefaultTimeoutMs, ensureMinMs, undefined);
    const { result, command } = await runCli(args, { timeoutMs });
    const parsed = await parseJsonObject(result, command);
    const taskId = requireStringField(
      parsed,
      "task_id",
      command,
      result.stdout,
      result.durationMs,
    );
    const statusRaw = parsed.status;
    const status = statusRaw === "completed" ? "completed" : "pending";
    const url = input.wait ? optionalStringField(parsed, "url") : null;
    return { taskId, status, url };
  }

  async function waitForArtifact(input: {
    notebookExternalId: string;
    artifactExternalId: string;
    timeoutSec?: number;
    pollIntervalMs?: number;
  }): Promise<WaitArtifactResult> {
    const timeoutSec = input.timeoutSec ?? ARTIFACT_WAIT_DEFAULT_TIMEOUT_SEC;
    const intervalSec = pollIntervalSeconds(input.pollIntervalMs);
    const args = [
      "artifact",
      "wait",
      input.artifactExternalId,
      "-n",
      input.notebookExternalId,
      "--timeout",
      String(timeoutSec),
    ];
    if (intervalSec !== undefined) {
      args.push("--interval", String(intervalSec));
    }
    args.push("--json");
    const ensuredMs = resolveTimeoutMs(
      baseDefaultTimeoutMs,
      (timeoutSec + WAIT_BUFFER_MS / 1000) * 1000,
      undefined,
    );
    let outcome: { result: SpawnResult; command: string };
    try {
      outcome = await runCli(args, { timeoutMs: ensuredMs });
    } catch (err) {
      if (
        err instanceof NotebookLmError &&
        err.exitCode === ARTIFACT_WAIT_TIMEOUT_EXIT_CODE
      ) {
        return { status: "timeout", url: null, attempts: 0 };
      }
      throw err;
    }
    const parsed = await parseJsonObject(outcome.result, outcome.command);
    const statusRaw = parsed.status;
    const url = optionalStringField(parsed, "url");
    if (statusRaw === "completed") {
      return { status: "completed", url, attempts: 1 };
    }
    return { status: "completed", url, attempts: 1 };
  }

  async function downloadAudio(
    input: DownloadAudioInput,
  ): Promise<DownloadAudioResult> {
    const args = [
      "download",
      "audio",
      input.destinationPath,
      "-n",
      input.notebookExternalId,
      "-a",
      input.artifactExternalId,
      "--force",
      "--json",
    ];
    const { result, command } = await runCli(args);
    const parsed = await parseJsonObject(result, command);
    const pathFromJson = optionalStringField(parsed, "path");
    const destinationPath = pathFromJson ?? input.destinationPath;
    let bytes = 0;
    try {
      const stats = await stat(destinationPath);
      bytes = stats.size;
    } catch {
      bytes = 0;
    }
    return { destinationPath, bytes };
  }

  async function authCheck(): Promise<{ ok: boolean; details: unknown }> {
    const args = ["auth", "check", "--test", "--json"];
    try {
      const { result, command } = await runCli(args);
      const parsed = await parseJsonObject(result, command);
      const checks = parsed.checks;
      const tokenFetchOk =
        isPlainObject(checks) && checks.token_fetch === true;
      const statusOk = parsed.status === "ok";
      return { ok: statusOk && tokenFetchOk, details: parsed };
    } catch (err) {
      if (err instanceof NotebookLmError) {
        const stdoutDetails = parseTrailingJson(err.stdout);
        const stderrDetails = stdoutDetails ?? parseTrailingJson(err.stderr);
        return { ok: false, details: stderrDetails ?? "" };
      }
      throw err;
    }
  }

  async function listNotebooks(): Promise<
    Array<{ id: string; title: string; createdAt: string | null }>
  > {
    const args = ["list", "--json"];
    const { result, command } = await runCli(args);
    const parsed = await parseJsonObject(result, command);
    const notebooks = parsed.notebooks;
    const output: Array<{
      id: string;
      title: string;
      createdAt: string | null;
    }> = [];
    if (Array.isArray(notebooks)) {
      for (const entry of notebooks) {
        if (!isPlainObject(entry)) continue;
        const id = entry.id;
        const title = entry.title;
        if (typeof id !== "string" || typeof title !== "string") continue;
        output.push({
          id,
          title,
          createdAt: optionalStringField(entry, "created_at"),
        });
      }
    }
    return output;
  }

  return {
    createNotebook,
    addSource,
    waitForSource,
    generateAudio,
    waitForArtifact,
    downloadAudio,
    authCheck,
    listNotebooks,
  };
}
