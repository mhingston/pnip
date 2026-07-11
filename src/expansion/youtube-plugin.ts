import { execFile } from "node:child_process";
import type {
  ExpansionPlugin,
  ExpandContext,
  ExpandResult,
  SectionData,
} from "./types.js";
import { loadConfig } from "../config/index.js";

export type TranscriptFetcher = (url: string) => Promise<string>;
export type MetadataFetcher = (url: string) => Promise<YouTubeMetadata>;

export interface YouTubeMetadata {
  title: string;
  author_name: string;
  author_url?: string;
  thumbnail_url?: string;
}

export interface TranscriptSegment {
  timestamp: number;
  text: string;
}

const SEGMENTS_PER_SECTION = 10;

async function defaultTranscriptFetcher(url: string): Promise<string> {
  const bin = loadConfig().FABRIC_BIN ?? "fabric";
  return new Promise((resolve, reject) => {
    const proc = execFile(
      bin,
      ["-y", url, "--transcript-with-timestamps"],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
    if (proc.stdin) {
      proc.stdin.end();
    }
  });
}

async function defaultMetadataFetcher(url: string): Promise<YouTubeMetadata> {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  );
  if (!res.ok) {
    throw new Error(`oEmbed request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as YouTubeMetadata;
  return {
    title: json.title,
    author_name: json.author_name,
    author_url: json.author_url,
    thumbnail_url: json.thumbnail_url,
  };
}

export function extractVideoId(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id || undefined;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const embedIdx = parts.indexOf("embed");
      if (embedIdx !== -1 && parts[embedIdx + 1]) return parts[embedIdx + 1];
      const shortsIdx = parts.indexOf("shorts");
      if (shortsIdx !== -1 && parts[shortsIdx + 1]) {
        // Shorts URLs can include trailing query params on the id segment
        return parts[shortsIdx + 1]!.split("?")[0] || undefined;
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function parseTranscript(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = raw.split("\n");
  const re = /^\[(\d{2}):(\d{2}):(\d{2})\]\s?(.*)$/;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(re);
    if (!m) continue;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    const s = Number.parseInt(m[3], 10);
    segments.push({ timestamp: h * 3600 + min * 60 + s, text: m[4] });
  }
  return segments;
}

function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

export function buildTranscriptSections(segments: TranscriptSegment[]): SectionData[] {
  const sections: SectionData[] = [];
  for (let i = 0; i < segments.length; i += SEGMENTS_PER_SECTION) {
    const chunk = segments.slice(i, i + SEGMENTS_PER_SECTION);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    sections.push({
      order: sections.length,
      section_type: "transcript",
      heading: `Transcript ${formatTimestamp(first.timestamp)}–${formatTimestamp(last.timestamp)}`,
      content_markdown: chunk
        .map((s) => `[${formatTimestamp(s.timestamp)}] ${s.text}`)
        .join("\n"),
      content_text: chunk.map((s) => s.text).join(" "),
    });
  }
  return sections;
}

export function createYouTubePlugin(opts?: {
  transcriptFetcher?: TranscriptFetcher;
  metadataFetcher?: MetadataFetcher;
}): ExpansionPlugin {
  const transcriptFetcher = opts?.transcriptFetcher ?? defaultTranscriptFetcher;
  const metadataFetcher = opts?.metadataFetcher ?? defaultMetadataFetcher;

  return {
    name: "youtube",

    supports(url: string): boolean {
      try {
        const u = new URL(url);
        const host = u.hostname;
        if (host === "youtu.be" || host.endsWith(".youtu.be")) return true;
        if (host === "youtube.com" || host.endsWith(".youtube.com")) {
          if (u.pathname === "/watch" || u.pathname.startsWith("/watch?")) return true;
          if (u.pathname.startsWith("/embed/")) return true;
          if (u.pathname.startsWith("/shorts/")) return true;
          return false;
        }
        return false;
      } catch {
        return false;
      }
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const meta = await metadataFetcher(context.url);
      const raw = await transcriptFetcher(context.url);
      if (raw.trim() === "") {
        throw new Error(`no transcript available for ${context.url}`);
      }
      const segments = parseTranscript(raw);
      const sections = buildTranscriptSections(segments);
      const plainText = segments.map((s) => s.text).join(" ");

      return {
        title: meta.title,
        content: raw,
        plainText,
        sourceType: "youtube",
        canonicalUrl: context.url,
        authors: [meta.author_name],
        publisher: "YouTube",
        sections,
        metadata: {
          thumbnail_url: meta.thumbnail_url,
          author_name: meta.author_name,
          author_url: meta.author_url,
          videoId: extractVideoId(context.url),
        },
      };
    },
  };
}
