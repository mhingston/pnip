import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type {
  ExpansionPlugin,
  ExpandContext,
  ExpandResult,
  SectionData,
} from "./types.js";
import { loadConfig } from "../config/index.js";

export type AudioDownloader = (url: string) => Promise<string>;
export type TranscribeFetcher = (filePath: string) => Promise<string>;

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".wav",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
];

const TRANSCRIBE_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function extFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").pop() ?? "";
    const dot = seg.lastIndexOf(".");
    if (dot === -1) return "mp3";
    return seg.slice(dot + 1).toLowerCase();
  } catch {
    return "mp3";
  }
}

async function defaultAudioDownloader(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`audio download failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  const hint = parseFilenameFromContentDisposition(
    res.headers.get("Content-Disposition"),
  );
  let ext: string;
  if (hint) {
    const dot = hint.lastIndexOf(".");
    ext = dot !== -1 ? hint.slice(dot + 1) : "mp3";
  } else {
    ext = extFromUrl(url);
  }
  const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(os.tmpdir(), `pnip-podcast-${unique}.${ext}`);
  await fs.writeFile(tmpPath, Buffer.from(buf));
  return tmpPath;
}

async function defaultTranscribeFetcher(
  filePath: string,
  model: string = "whisper-1",
): Promise<string> {
  const bin = loadConfig().FABRIC_BIN ?? "fabric";
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = execFile(
        bin,
        ["--transcribe-file", filePath, "--transcribe-model", model],
        { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (err, out) => {
          if (err) { reject(err); return; }
          resolve(out);
        },
      );
      if (proc.stdin) proc.stdin.end();
    });
    return stdout;
  } catch (err) {
    const stderr =
      err !== null &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `fabric --transcribe-file failed: ${msg}${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

export function deriveTitleFromUrl(url: string): string {
  let seg: string;
  try {
    seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    seg = "";
  }
  if (!seg) return "Audio";
  const dot = seg.lastIndexOf(".");
  const base = dot !== -1 ? seg.slice(0, dot) : seg;
  const spaced = base.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Audio";
  return titleCase(spaced);
}

export function parseFilenameFromContentDisposition(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  const match = header.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : undefined;
}

export function buildTranscriptSections(transcript: string): SectionData[] {
  if (transcript.trim() === "") return [];
  const parts = transcript
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.map((part, i) => ({
    order: i,
    section_type: "transcript",
    heading: `Transcript part ${i + 1}`,
    content_markdown: part,
    content_text: part,
  }));
}

export function createPodcastPlugin(opts?: {
  transcribeFetcher?: TranscribeFetcher;
  audioDownloader?: AudioDownloader;
  transcribeModel?: string;
}): ExpansionPlugin {
  const model = opts?.transcribeModel ?? "whisper-1";
  const transcribeFetcher =
    opts?.transcribeFetcher ??
    ((filePath: string) => defaultTranscribeFetcher(filePath, model));
  const audioDownloader = opts?.audioDownloader ?? defaultAudioDownloader;

  return {
    name: "podcast",

    supports(url: string): boolean {
      try {
        const p = new URL(url).pathname.toLowerCase();
        return AUDIO_EXTENSIONS.some((ext) => p.endsWith(ext));
      } catch {
        return false;
      }
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const tmpPath = await audioDownloader(context.url);
      try {
        const transcript = await transcribeFetcher(tmpPath);
        if (transcript.trim() === "") {
          throw new Error(`transcription failed for ${context.url}`);
        }
        const title = deriveTitleFromUrl(context.url);
        const sections = buildTranscriptSections(transcript);
        return {
          title,
          content: transcript,
          plainText: transcript,
          sourceType: "podcast",
          canonicalUrl: context.url,
          sections,
          metadata: { sourceUrl: context.url },
        };
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    },
  };
}
