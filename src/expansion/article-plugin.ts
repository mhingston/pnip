import type { ExpansionPlugin, ExpandContext, ExpandResult, SectionData } from "./types.js";

export type ContentFetcher = (url: string) => Promise<string>;

function extractTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : undefined;
}

function simpleHtmlToMarkdown(html: string): string {
  let md = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return md;
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

async function defaultFetchContent(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PNIP/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const html = await res.text();
  return simpleHtmlToMarkdown(html);
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
      const content = await fetchContent(context.url);
      const plainText = content
        .replace(/#{1,6}\s+/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const title = extractTitle(content) ?? context.url;
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
