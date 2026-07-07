import type {
  ExpandContext,
  ExpandResult,
  ExpansionPlugin,
  SectionData,
} from "./types.js";
import { createDefaultRssFetcher } from "./reddit-rate-limiter.js";
import type { RssFetcher } from "./reddit-rate-limiter.js";

export type { RssFetcher } from "./reddit-rate-limiter.js";

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  createdUtc: Date;
  score?: number;
  stickied?: boolean;
  distinguished?: string | null;
}

export interface RedditSubmission {
  id: string;
  title: string;
  selftext: string;
  author: string;
  subreddit: string;
  createdUtc: Date;
  url: string;
  permalink: string;
}

export interface RedditThread {
  submission: RedditSubmission;
  comments: RedditComment[];
}

export function isRedditUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("reddit.com") && u.pathname.includes("/comments/");
  } catch {
    return false;
  }
}

export function extractArticleId(url: string): string | undefined {
  if (!isRedditUrl(url)) return undefined;
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("comments");
    if (idx === -1 || idx + 1 >= segments.length) return undefined;
    return segments[idx + 1];
  } catch {
    return undefined;
  }
}

export function toRssUrl(url: string): string {
  const u = new URL(url);
  u.search = "";
  let pathname = u.pathname;
  if (!pathname.endsWith("/")) pathname += "/";
  pathname += ".rss";
  u.pathname = pathname;
  return u.toString();
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&quot;": '"',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|#39|quot);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).trim();
}

function htmlToMarkdown(html: string): string {
  let s = decodeEntities(html);
  s = s.replace(/<!--\s*SC_OFF\s*-->/g, "").replace(/<!--\s*SC_ON\s*-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, url: string, text: string) =>
    `[${text}](${url})`,
  );
  s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  s = s.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripSubmittedBy(md: string): string {
  const idx = md.lastIndexOf("submitted by");
  if (idx >= 0) return md.slice(0, idx).trim();
  return md;
}

function extractField(pattern: RegExp, xml: string): string | undefined {
  const m = xml.match(pattern);
  return m ? m[1] : undefined;
}

function extractEntries(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

export function parseAtomFeed(xml: string): RedditThread {
  const entries = extractEntries(xml);
  let submission: RedditSubmission | undefined;
  const comments: RedditComment[] = [];

  for (const block of entries) {
    const id = extractField(/<id>([^<]+)<\/id>/, block);
    if (!id) continue;
    const authorRaw = extractField(/<author>\s*<name>([^<]+)<\/name>/, block) ?? "";
    const author = authorRaw.replace(/^\/u\//, "");
    const contentHtml = extractField(
      /<content[^>]*>([\s\S]*?)<\/content>/,
      block,
    );
    const updated = extractField(/<updated>([^<]+)<\/updated>/, block);
    const published = extractField(/<published>([^<]+)<\/published>/, block);
    const link = extractField(/<link[^>]*href="([^"]+)"/, block);
    const category = extractField(/<category[^>]*term="([^"]+)"/, block);

    if (id.startsWith("t3_")) {
      const title = extractField(/<title>([^<]+)<\/title>/, block) ?? "";
      const selftext = contentHtml
        ? stripSubmittedBy(htmlToMarkdown(contentHtml))
        : "";
      submission = {
        id: id.slice(3),
        title,
        selftext,
        author,
        subreddit: category ?? "",
        createdUtc: new Date(published ?? updated ?? Date.now()),
        url: link ?? "",
        permalink: link ?? "",
      };
    } else if (id.startsWith("t1_")) {
      if (!contentHtml || contentHtml.trim() === "") continue;
      const body = htmlToMarkdown(contentHtml);
      if (body === "" || body === "[deleted]" || body === "[removed]") continue;
      comments.push({
        id: id.slice(3),
        author,
        body,
        createdUtc: new Date(updated ?? Date.now()),
      });
    }
  }

  if (!submission) {
    throw new Error("Atom feed missing submission (t3_) entry");
  }
  return { submission, comments };
}

function isEmptyComment(body: string): boolean {
  const trimmed = body.trim();
  return trimmed === "" || trimmed === "[deleted]" || trimmed === "[removed]";
}

export function buildRedditSections(thread: RedditThread): SectionData[] {
  const sections: SectionData[] = [];
  const sub = thread.submission;
  const subContent = sub.selftext.trim() !== "" ? sub.selftext : sub.url;
  sections.push({
    order: 0,
    section_type: "reddit_submission",
    heading: sub.title,
    content_markdown: subContent,
    content_text: subContent,
  });
  for (const comment of thread.comments) {
    if (isEmptyComment(comment.body)) continue;
    sections.push({
      order: sections.length,
      section_type: "reddit_comment",
      heading: `u/${comment.author}`,
      content_markdown: comment.body,
      content_text: comment.body,
    });
  }
  return sections;
}

function buildContent(thread: RedditThread): { content: string; plainText: string } {
  const sub = thread.submission;
  const subContent = sub.selftext.trim() !== "" ? sub.selftext : sub.url;
  const parts: string[] = [`# ${sub.title}`, "", subContent];
  for (const comment of thread.comments) {
    if (isEmptyComment(comment.body)) continue;
    parts.push("", "---", "", `u/${comment.author}`, "", comment.body);
  }
  const content = parts.join("\n");
  const plainText = content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^---$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content, plainText };
}

export function createRedditPlugin(opts?: { fetcher?: RssFetcher }): ExpansionPlugin {
  return {
    name: "reddit",

    supports(url: string): boolean {
      return isRedditUrl(url);
    },

    async expand(context: ExpandContext): Promise<ExpandResult> {
      const articleId = extractArticleId(context.url);
      if (!articleId) {
        throw new Error(`Not a Reddit comments URL: ${context.url}`);
      }
      const fetcher = opts?.fetcher ?? createDefaultRssFetcher();
      const rssUrl = toRssUrl(context.url);
      const xml = await fetcher(rssUrl);
      const thread = parseAtomFeed(xml);
      const sections = buildRedditSections(thread);
      const { content, plainText } = buildContent(thread);
      const sub = thread.submission;
      return {
        title: sub.title,
        content,
        plainText,
        sourceType: "reddit",
        canonicalUrl: sub.url || context.url,
        authors: [sub.author],
        publishedAt: sub.createdUtc,
        sections,
        metadata: {
          subreddit: sub.subreddit,
          articleId: sub.id,
        },
      };
    },
  };
}
