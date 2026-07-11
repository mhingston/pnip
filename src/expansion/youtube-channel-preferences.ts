/**
 * Channel matching is intentionally tolerant. YouTube's oEmbed response may
 * identify the same channel by display name, @handle, or /channel/{id}; the
 * document stores more than one of those fields when available.
 */

export interface YouTubeChannelDocumentLike {
  sourceType: string;
  sourceIdentity?: string | null;
  metadata?: unknown;
  authors?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Normalize names, handles, and YouTube identity keys to a comparison key. */
export function normalizeYoutubeChannel(value: string): string {
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/^https?:\/\//, "");
  candidate = candidate.replace(/^www\./, "");
  candidate = candidate.replace(/^youtube\.com\//, "");
  candidate = candidate.replace(/^youtube\.com:/, "");
  candidate = candidate.replace(/^channel:/, "");
  candidate = candidate.replace(/^@/, "");
  candidate = candidate.replace(/^channel\//, "");
  return candidate.replace(/[^a-z0-9]+/g, "");
}

function addCandidate(out: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") return;
  const normalized = normalizeYoutubeChannel(value);
  if (normalized) out.add(normalized);
}

function candidatesForDocument(input: YouTubeChannelDocumentLike): Set<string> {
  const out = new Set<string>();
  addCandidate(out, input.sourceIdentity);

  const metadata = isRecord(input.metadata) ? input.metadata : {};
  addCandidate(out, metadata.author_name);
  addCandidate(out, metadata.author_url);

  for (const author of parseJsonArray(input.authors)) addCandidate(out, author);
  return out;
}

/** Return true when a YouTube document belongs to one of the configured channels. */
export function isFocusedYoutubeChannel(
  input: YouTubeChannelDocumentLike,
  configuredChannels: readonly string[] | undefined,
): boolean {
  if (input.sourceType.toLowerCase() !== "youtube") return false;
  if (!configuredChannels || configuredChannels.length === 0) return false;

  const configured = new Set(
    configuredChannels
      .map(normalizeYoutubeChannel)
      .filter((value) => value.length > 0),
  );
  if (configured.size === 0) return false;

  for (const candidate of candidatesForDocument(input)) {
    if (configured.has(candidate)) return true;
  }
  return false;
}

/** Extra ranking weight applied to a focused YouTube source. */
export const YOUTUBE_FOCUS_RANK_BOOST = 4;
