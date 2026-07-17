import { execFile } from "node:child_process";
import type { ExpansionPlugin, ExpandContext, ExpandResult, SectionData } from "./types.js";
import { loadConfig } from "../config/index.js";

export type ContentFetcher = (url: string) => Promise<string>;

interface FabricParsed {
  title?: string;
  canonicalUrl?: string;
  publishedAt?: Date;
  content: string;
}

export function parseFabricOutput(raw: string): FabricParsed {
  const lines = raw.split("\n");
  const markerIdx = lines.findIndex((l) => l.startsWith("Markdown Content:"));
  if (markerIdx === -1) {
    return { content: raw };
  }

  const headerLines = lines.slice(0, markerIdx);
  let bodyLines = lines.slice(markerIdx + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
  const content = bodyLines.join("\n");

  let title: string | undefined;
  let canonicalUrl: string | undefined;
  let publishedAt: Date | undefined;

  for (const line of headerLines) {
    if (line.startsWith("Title:")) {
      const v = line.slice("Title:".length).trim();
      title = v || undefined;
    } else if (line.startsWith("URL Source:")) {
      const v = line.slice("URL Source:".length).trim();
      canonicalUrl = v || undefined;
    } else if (line.startsWith("Published Time:")) {
      const v = line.slice("Published Time:".length).trim();
      if (v) {
        const d = new Date(v);
        publishedAt = isNaN(d.getTime()) ? undefined : d;
      }
    }
  }

  return { title, canonicalUrl, publishedAt, content };
}

function extractTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : undefined;
}

function usableTitle(candidate: string | undefined, url: string): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed || trimmed === url) return undefined;
  return trimmed;
}

function parseSections(content: string): SectionData[] {
  const lines = content.split("\n");
  const sections: SectionData[] = [];
  let current: SectionData | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      if (!current || current.section_type === "title" || current.section_type === "heading") {
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
    sections.push({ order: 0, section_type: "paragraph", content_markdown: content, content_text: content });
  }

  return sections;
}

function reindexSections(sections: SectionData[]): SectionData[] {
  return sections.map((section, index) => ({
    ...section,
    order: index,
  }));
}

async function defaultFetchContent(url: string): Promise<string> {
  const bin = loadConfig().FABRIC_BIN ?? "fabric";
  return new Promise((resolve, reject) => {
    const proc = execFile(bin, ["-u", url], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
    if (proc.stdin) {
      proc.stdin.end();
    }
  });
}

export function createArticlePlugin(opts?: {
  fetchContent?: ContentFetcher;
}): ExpansionPlugin {
  const fetchContent = opts?.fetchContent ?? defaultFetchContent;

  return {
    name: "article",

    supports(url: string): boolean {
      const host = new URL(url).hostname;
      if (host.includes("youtube.com") || host.includes("youtu.be")) return false;
      if (host.includes("reddit.com")) return false;
      return url.startsWith("http://") || url.startsWith("https://");
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const raw = await fetchContent(context.url);
      const parsed = parseFabricOutput(raw);
      const content = parsed.content;
      const plainText = content
        .replace(/#{1,6}\s+/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const title =
        usableTitle(parsed.title, context.url) ??
        usableTitle(extractTitle(content), context.url) ??
        usableTitle(context.title, context.url) ??
        context.url;
      const sections = parseSections(content);
      const titleSection = sections.find((s) => s.section_type === "title");
      const remainingSections = sections.filter((s) => s.section_type !== "title");
      const orderedSections = titleSection
        ? [titleSection, ...remainingSections]
        : [
            {
              order: 0,
              section_type: "title",
              content_markdown: `# ${title}`,
              content_text: title,
            },
            ...remainingSections,
          ];

      return {
        title,
        content,
        plainText,
        sourceType: "article",
        canonicalUrl: parsed.canonicalUrl,
        publishedAt: parsed.publishedAt,
        sections: reindexSections(orderedSections),
      };
    },
  };
}
