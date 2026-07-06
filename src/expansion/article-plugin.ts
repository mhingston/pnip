import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExpansionPlugin, ExpandContext, ExpandResult, SectionData } from "./types.js";

const execFileAsync = promisify(execFile);

export type ContentFetcher = (url: string) => Promise<string>;

function defaultContentFetcher(fabricBin?: string): ContentFetcher {
  const bin = fabricBin ?? "fabric";
  return async (url: string): Promise<string> => {
    const { stdout } = await execFileAsync(bin, ["-y", url], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  };
}

function parseTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : undefined;
}

function parseSections(content: string): SectionData[] {
  const lines = content.split("\n");
  const sections: SectionData[] = [];
  let current: SectionData | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        order: sections.length,
        heading: headingMatch[2].trim(),
        section_type: headingMatch[1].length === 1 ? "title" : "heading",
        content_markdown: line,
        content_text: line.replace(/#{1,3}\s+/, ""),
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
  if (current) {
    sections.push(current);
  }

  return sections;
}

export function createArticlePlugin(opts?: {
  fetchContent?: ContentFetcher;
  fabricBin?: string;
}): ExpansionPlugin {
  const fetchContent = opts?.fetchContent ?? defaultContentFetcher(opts?.fabricBin);

  return {
    name: "article",

    supports(url: string): boolean {
      return url.startsWith("http://") || url.startsWith("https://");
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const content = await fetchContent(context.url);
      const plainText = content
        .replace(/#{1,6}\s+/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const title = parseTitle(content) ?? context.url;
      const sections = parseSections(content);
      const titleSection = sections.find((s) => s.section_type === "title");
      const remainingSections = sections.filter((s) => s.section_type !== "title");

      return {
        title,
        content,
        plainText,
        sourceType: "article",
        sections: titleSection
          ? [titleSection, ...remainingSections]
          : [
              {
                order: 0,
                section_type: "title",
                content_markdown: `# ${title}`,
                content_text: title,
              },
              ...remainingSections,
            ],
      };
    },
  };
}
