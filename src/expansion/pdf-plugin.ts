import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

export type PdfDownloader = (url: string) => Promise<string>;
export type MarkdownFetcher = (filePath: string) => Promise<string>;

const MARKITDOWN_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

async function defaultPdfDownloader(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`pdf download failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(os.tmpdir(), `pnip-pdf-${unique}.pdf`);
  await fs.writeFile(tmpPath, Buffer.from(buf));
  return tmpPath;
}

async function defaultMarkdownFetcher(filePath: string): Promise<string> {
  const bin = loadConfig().MARKITDOWN_BIN ?? "markitdown";
  try {
    const { stdout } = await execFileAsync(bin, [filePath], {
      timeout: MARKITDOWN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
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
      `markitdown failed: ${msg}${stderr ? `\n${stderr}` : ""}`,
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
  if (!seg) return "Pdf";
  const base = seg.toLowerCase().endsWith(".pdf")
    ? seg.slice(0, seg.length - 4)
    : seg;
  const spaced = base.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Pdf";
  return titleCase(spaced);
}

export function extractTitleFromMarkdown(content: string): {
  title: string | undefined;
  body: string;
} {
  const match = content.match(/^#\s+(.+)/);
  if (!match) return { title: undefined, body: content };
  const title = match[1].trim();
  const body = content.slice(match.index! + match[0].length).replace(/^\n+/, "");
  return { title, body };
}

function parseSections(content: string): SectionData[] {
  const lines = content.split("\n");
  const sections: SectionData[] = [];
  let current: SectionData | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        order: sections.length,
        heading: headingMatch[2].trim(),
        section_type: headingMatch[1].length === 1 ? "title" : "heading",
        content_markdown: line,
        content_text: headingMatch[2].trim(),
      };
    } else if (line.trim()) {
      if (
        !current ||
        current.section_type === "title" ||
        current.section_type === "heading"
      ) {
        if (current) sections.push(current);
        current = {
          order: sections.length,
          section_type: "paragraph",
          content_markdown: line,
          content_text: line,
        };
      } else {
        current.content_markdown = (current.content_markdown ?? "") + "\n" + line;
        current.content_text = (current.content_text ?? "") + " " + line;
      }
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    sections.push({
      order: 0,
      section_type: "paragraph",
      content_markdown: content,
      content_text: content,
    });
  }

  return sections;
}

function stripMarkdownHeadings(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createPdfPlugin(opts?: {
  pdfDownloader?: PdfDownloader;
  markdownFetcher?: MarkdownFetcher;
}): ExpansionPlugin {
  const pdfDownloader = opts?.pdfDownloader ?? defaultPdfDownloader;
  const markdownFetcher = opts?.markdownFetcher ?? defaultMarkdownFetcher;

  return {
    name: "pdf",

    supports(url: string): boolean {
      try {
        const p = new URL(url).pathname.toLowerCase();
        return p.endsWith(".pdf");
      } catch {
        return false;
      }
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const tmpPath = await pdfDownloader(context.url);
      try {
        const raw = await markdownFetcher(tmpPath);
        if (raw.trim() === "") {
          throw new Error(`PDF extraction failed for ${context.url}`);
        }
        const { title: h1Title, body } = extractTitleFromMarkdown(raw);
        const title = h1Title ?? deriveTitleFromUrl(context.url);
        const sections = parseSections(body);
        const plainText = stripMarkdownHeadings(body);
        return {
          title,
          content: body,
          plainText,
          sourceType: "pdf",
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
