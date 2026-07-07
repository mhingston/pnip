import { loadConfig } from "../config/index.js";
import type {
  ExpandContext,
  ExpandResult,
  ExpansionPlugin,
  SectionData,
} from "./types.js";

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc: Date;
  stickied: boolean;
  isSubmitter: boolean;
  distinguished: string | null;
  replies: RedditComment[];
}

export interface RedditSubmission {
  id: string;
  title: string;
  selftext: string;
  author: string;
  subreddit: string;
  score: number;
  numComments: number;
  upvoteRatio: number;
  createdUtc: Date;
  url: string;
  permalink: string;
  isSelf: boolean;
  flairText: string | null;
  stickied: boolean;
  over18: boolean;
}

export interface RedditThread {
  submission: RedditSubmission;
  comments: RedditComment[];
}

export type RedditFetcher = (url: string) => Promise<unknown>;
export type TokenFetcher = () => Promise<string>;

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
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

export function parseSubmission(data: Record<string, unknown>): RedditSubmission {
  const createdUtc = asNumber(data.created_utc, 0);
  return {
    id: asString(data.id),
    title: asString(data.title),
    selftext: asString(data.selftext),
    author: asString(data.author),
    subreddit: asString(data.subreddit),
    score: asNumber(data.score),
    numComments: asNumber(data.num_comments),
    upvoteRatio: asNumber(data.upvote_ratio),
    createdUtc: new Date(createdUtc * 1000),
    url: asString(data.url),
    permalink: asString(data.permalink),
    isSelf: asBool(data.is_self),
    flairText:
      typeof data.link_flair_text === "string" ? data.link_flair_text : null,
    stickied: asBool(data.stickied),
    over18: asBool(data.over_18),
  };
}

export function parseComment(data: Record<string, unknown>): RedditComment {
  const repliesRaw = data.replies;
  let replies: RedditComment[] = [];
  if (repliesRaw !== null && typeof repliesRaw === "object") {
    const listing = repliesRaw as {
      data?: { children?: Array<{ kind?: string; data?: Record<string, unknown> }> };
    };
    const children = listing.data?.children ?? [];
    replies = children
      .filter((c) => c.kind === "t1" && c.data)
      .map((c) => parseComment(c.data as Record<string, unknown>));
  }
  const createdUtc = asNumber(data.created_utc, 0);
  const distinguished =
    typeof data.distinguished === "string" ? data.distinguished : null;
  return {
    id: asString(data.id),
    author: asString(data.author),
    body: asString(data.body),
    score: asNumber(data.score),
    createdUtc: new Date(createdUtc * 1000),
    stickied: asBool(data.stickied),
    isSubmitter: asBool(data.is_submitter),
    distinguished,
    replies,
  };
}

interface ListingContainer {
  kind: string;
  data?: { children?: Array<{ kind?: string; data?: Record<string, unknown> }> };
}

export function parseThread(response: unknown): RedditThread {
  if (!Array.isArray(response) || response.length < 2) {
    throw new Error("Reddit API response must be a two-element listing array");
  }
  const submissionListing = response[0] as ListingContainer;
  const commentsListing = response[1] as ListingContainer;
  const subChild = (submissionListing.data?.children ?? []).find(
    (c) => c.kind === "t3" && c.data,
  );
  if (!subChild || !subChild.data) {
    throw new Error("Reddit API response missing submission (t3) child");
  }
  const submission = parseSubmission(subChild.data);
  const comments = (commentsListing.data?.children ?? [])
    .filter((c) => c.kind === "t1" && c.data)
    .map((c) => parseComment(c.data as Record<string, unknown>));
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
    const heading = `u/${comment.author} (score: ${comment.score})`;
    sections.push({
      order: sections.length,
      section_type: "reddit_comment",
      heading,
      content_markdown: comment.body,
      content_text: comment.body,
    });
  }
  return sections;
}

function formatCommentMarkdown(comment: RedditComment, depth: number): string {
  const indent = "  ".repeat(depth);
  const header = `${indent}u/${comment.author} (score: ${comment.score})`;
  const lines = [header, `${indent}${comment.body}`];
  for (const reply of comment.replies) {
    if (isEmptyComment(reply.body)) continue;
    lines.push(formatCommentMarkdown(reply, depth + 1));
  }
  return lines.join("\n");
}

function buildContent(thread: RedditThread): {
  content: string;
  plainText: string;
} {
  const sub = thread.submission;
  const subContent = sub.selftext.trim() !== "" ? sub.selftext : sub.url;
  const parts: string[] = [`# ${sub.title}`, "", subContent];
  for (const comment of thread.comments) {
    if (isEmptyComment(comment.body)) continue;
    parts.push("", "---", "", formatCommentMarkdown(comment, 0));
  }
  const content = parts.join("\n");
  const plainText = content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^---$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content, plainText };
}

export function createDefaultTokenFetcher(
  clientId: string,
  clientSecret: string,
  userAgent: string,
): TokenFetcher {
  let cachedToken: string | undefined;
  let expiresAt = 0;
  return async () => {
    const now = Date.now();
    if (cachedToken && now < expiresAt) return cachedToken;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(
        `Reddit token fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const token = asString(json.access_token);
    const expiresIn = asNumber(json.expires_in, 0);
    if (!token) {
      throw new Error("Reddit token response missing access_token");
    }
    cachedToken = token;
    expiresAt = now + (expiresIn - 60) * 1000;
    return token;
  };
}

export function createDefaultRedditFetcher(
  tokenFetcher: TokenFetcher,
  userAgent: string,
): RedditFetcher {
  return async (url: string) => {
    const token = await tokenFetcher();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent,
      },
    });
    if (!res.ok) {
      throw new Error(
        `Reddit API fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as unknown;
  };
}

export function createRedditPlugin(opts?: {
  fetcher?: RedditFetcher;
  tokenFetcher?: TokenFetcher;
}): ExpansionPlugin {
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
      let fetcher = opts?.fetcher;
      if (!fetcher) {
        const config = loadConfig();
        const clientId = config.REDDIT_CLIENT_ID;
        const clientSecret = config.REDDIT_CLIENT_SECRET;
        const userAgent = config.REDDIT_USER_AGENT;
        if (!clientId || !clientSecret || !userAgent) {
          throw new Error("Reddit credentials not configured");
        }
        const tokenFetcher =
          opts?.tokenFetcher ??
          createDefaultTokenFetcher(clientId, clientSecret, userAgent);
        fetcher = createDefaultRedditFetcher(tokenFetcher, userAgent);
      }
      const apiUrl = `${REDDIT_API_BASE}/comments/${articleId}?limit=10&sort=top`;
      const response = await fetcher(apiUrl);
      const thread = parseThread(response);
      const sections = buildRedditSections(thread);
      const { content, plainText } = buildContent(thread);
      const sub = thread.submission;
      return {
        title: sub.title,
        content,
        plainText,
        sourceType: "reddit",
        canonicalUrl: `https://www.reddit.com${sub.permalink}`,
        authors: [sub.author],
        publishedAt: sub.createdUtc,
        sections,
        metadata: {
          subreddit: sub.subreddit,
          score: sub.score,
          numComments: sub.numComments,
          upvoteRatio: sub.upvoteRatio,
          articleId: sub.id,
          flairText: sub.flairText,
        },
      };
    },
  };
}
