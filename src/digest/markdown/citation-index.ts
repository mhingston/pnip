/**
 * Deterministic citation indexing for the Markdown digest.
 *
 * §44 specifies: "Citation numbering should be deterministic" — the same set
 * of (chunk_id → claim_text) citations must always produce the same numbering
 * regardless of insertion order. We assign numbers by:
 *
 *   1. The order chunks first appear across the Edition's stories (lexicographic
 *      tiebreak on chunk_id so two chunks first seen at the same position still
 *      number deterministically).
 *   2. Numbering is 1-based and contiguous: [1], [2], [3]...
 *
 * No mutation: this helper is pure and reusable from any rendering step.
 */

export interface CitationRef {
  chunkId: string;
  claimText: string;
}

export interface CitationIndex {
  byChunkId: Map<string, number>;
  entries: { number: number; chunkId: string }[];
}

export function buildCitationIndex(
  citations: readonly CitationRef[],
): CitationIndex {
  const seenNumbers = new Map<string, number>();
  const entries: { number: number; chunkId: string }[] = [];

  for (const ref of citations) {
    if (seenNumbers.has(ref.chunkId)) continue;
    const n = seenNumbers.size + 1;
    seenNumbers.set(ref.chunkId, n);
    entries.push({ number: n, chunkId: ref.chunkId });
  }

  entries.sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.chunkId.localeCompare(b.chunkId);
  });

  const byChunkId = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    byChunkId.set(entries[i]!.chunkId, i + 1);
  }
  const reEntries: { number: number; chunkId: string }[] = [];
  for (let i = 0; i < byChunkId.size; i++) {
    const chunkId = [...byChunkId.keys()][i]!;
    reEntries.push({ number: i + 1, chunkId });
  }

  return { byChunkId, entries: reEntries };
}

/**
 * Render a citation number using the [N] form. Returns the input text wrapped
 * with the marker so it can sit inside a sentence, e.g. `cite(3)` -> `[3]`.
 */
export function citationToken(n: number): string {
  return `[${n}]`;
}

/**
 * Resolve a single chunk_id to its [N] token. Throws if the chunk id was not
 * present in the index — caller is expected to feed a complete index.
 */
export function citationTokenFor(index: CitationIndex, chunkId: string): string {
  const n = index.byChunkId.get(chunkId);
  if (n === undefined) {
    throw new Error(
      `chunk ${chunkId} not present in citation index (known: ${[
        ...index.byChunkId.keys(),
      ].join(", ")})`,
    );
  }
  return citationToken(n);
}
