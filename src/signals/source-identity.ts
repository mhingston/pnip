export interface SourceIdentityInput {
  sourceUrl: string;
  sourceType: string;
  publisher: string | null;
  metadata: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHostname(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function deriveReddit(url: URL): string {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].toLowerCase() === "r") {
      return `reddit.com/r/${segments[i + 1].toLowerCase()}`;
    }
  }
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].toLowerCase() === "user") {
      return `reddit.com/user/${segments[i + 1].toLowerCase()}`;
    }
  }
  return "reddit.com";
}

function deriveYoutube(metadata: unknown): string {
  const meta = isPlainObject(metadata) ? metadata : {};
  const authorUrl = meta.author_url;
  if (typeof authorUrl === "string" && authorUrl.length > 0) {
    try {
      const au = new URL(authorUrl);
      const channelMatch = au.pathname.match(/^\/channel\/([^/]+)/);
      if (channelMatch) {
        return `youtube.com/channel:${channelMatch[1]}`;
      }
      const handleMatch = au.pathname.match(/^\/@([^/]+)/);
      if (handleMatch) {
        return `youtube.com/@${handleMatch[1]}`;
      }
    } catch {
    }
  }
  const authorName = meta.author_name;
  if (typeof authorName === "string" && authorName.trim().length > 0) {
    return `youtube.com/channel:${authorName.trim()}`;
  }
  return "youtube.com";
}

function derivePodcast(input: SourceIdentityInput, url: URL): string {
  const publisher = input.publisher;
  if (publisher !== null && publisher.trim().length > 0) {
    return `podcast:${publisher.trim().toLowerCase()}`;
  }
  return normalizeHostname(url);
}

/**
 * Derive a normalized, deterministic grouping key for a signal's source.
 * Returns `null` only when the source URL is empty; returns the raw URL
 * string when it cannot be parsed (last-resort traceability).
 */
export function deriveSourceIdentity(input: SourceIdentityInput): string | null {
  const { sourceUrl, sourceType, publisher, metadata } = input;
  if (sourceUrl === "") return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }
  switch (sourceType) {
    case "article":
    case "pdf":
      return normalizeHostname(url);
    case "reddit":
      return deriveReddit(url);
    case "youtube":
      return deriveYoutube(metadata);
    case "podcast":
      return derivePodcast({ sourceUrl, sourceType, publisher, metadata }, url);
    default:
      return normalizeHostname(url);
  }
}
