import type { MinifluxEntry } from "./miniflux-client.js";

export type DiscoverySourceFamily = "reddit" | "article" | "youtube";

/**
 * Classify only what can be known before expansion. Feed counts are not a
 * substitute for available entries, so this deliberately uses the entry URL
 * rather than the Miniflux feed inventory.
 */
export function classifyDiscoverySourceFamily(url: string): DiscoverySourceFamily {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be"
    ) {
      return "youtube";
    }
    if (
      hostname === "reddit.com" ||
      hostname.endsWith(".reddit.com") ||
      hostname === "redd.it"
    ) {
      return "reddit";
    }
  } catch {
    // Invalid URLs are left in the general article bucket and will be
    // reported by the expansion worker if they cannot be processed.
  }
  return "article";
}

/**
 * Select a bounded set of historical candidates with deterministic,
 * signal-weighted source coverage. This is used only when the current cursor
 * does not provide enough entries; normal new-entry discovery remains
 * chronological and ingests every eligible entry.
 */
export function selectBalancedEntries(
  entries: readonly MinifluxEntry[],
  limit: number,
  balanced = true,
): MinifluxEntry[] {
  if (limit <= 0 || entries.length === 0) return [];

  const deduplicated = new Map<number, MinifluxEntry>();
  for (const entry of entries) {
    if (!deduplicated.has(entry.id)) deduplicated.set(entry.id, entry);
  }
  const unique = [...deduplicated.values()];
  if (!balanced) {
    return unique
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .sort((a, b) => a.id - b.id);
  }

  const buckets: Record<DiscoverySourceFamily, MinifluxEntry[]> = {
    // Articles and YouTube are preferred during historical fill. Reddit stays
    // eligible as a lower-signal fallback rather than receiving an equal quota.
    reddit: [],
    article: [],
    youtube: [],
  };
  for (const entry of unique.sort((a, b) => b.id - a.id)) {
    buckets[classifyDiscoverySourceFamily(entry.url)].push(entry);
  }

  const selected: MinifluxEntry[] = [];
  // Two slots each for articles and YouTube, then one for Reddit. If a
  // stronger bucket is exhausted, the remaining buckets naturally fill the
  // available slots.
  const order: DiscoverySourceFamily[] = [
    "article",
    "youtube",
    "article",
    "youtube",
    "reddit",
  ];
  while (selected.length < limit) {
    let madeProgress = false;
    for (const family of order) {
      const candidate = buckets[family].shift();
      if (!candidate) continue;
      selected.push(candidate);
      madeProgress = true;
      if (selected.length >= limit) break;
    }
    if (!madeProgress) break;
  }
  return selected.sort((a, b) => a.id - b.id);
}
