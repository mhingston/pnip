export interface DocumentClusterInput {
  documentId: string;
  summary: string;
  topics: string[];
  embedding: number[];
  publishedAt: Date | null;
}

export interface DocumentCluster {
  documentId: string;
  representativeTopic: string;
}

export interface ClusterOutput {
  label: string;
  documentIds: string[];
}

export interface ClusterOptions {
  similarityThreshold: number;
  minClusterSize: number;
  maxStories: number;
  /**
   * Optional RNG injection, kept for backward compatibility with older tests.
   * NOT used by the default code path: tiebreaks use deterministic orderings
   * (alphabetical sort of topics, sorted union-find iteration) so that
   * identical Edition contents always produce identical story labels and
   * membership. Pass `random` only if you specifically want to inject
   * randomness for adversarial testing — production callers should leave it
   * unset.
   */
  random?: () => number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  similarityThreshold: 0.5,
  minClusterSize: 1,
  maxStories: 100,
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `embedding dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function pickRepresentativeTopic(
  topics: readonly string[],
  rng?: () => number,
): string {
  if (topics.length === 0) return "general";
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of topics) {
    const norm = t.trim().toLowerCase();
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(norm);
  }
  if (deduped.length === 0) return "general";
  // Determinism: pick the lexicographically FIRST topic (stable across runs).
  // The `rng` parameter is preserved for backward-compatible testing only;
  // production callers leave it unset and rely on the alphabetical tiebreak.
  if (rng) {
    const idx = Math.floor(rng() * deduped.length);
    return deduped[Math.min(idx, deduped.length - 1)]!;
  }
  let best = deduped[0]!;
  for (let i = 1; i < deduped.length; i++) {
    const candidate = deduped[i]!;
    if (candidate < best) best = candidate;
  }
  return best;
}

function makeLabel(
  topic: string,
  index: number,
  used: Set<string>,
): string {
  const base = `story-${topic}-${index + 1}`.toLowerCase().replace(/\s+/g, "-");
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

export function clusterDocuments(
  inputs: readonly DocumentClusterInput[],
  opts?: Partial<ClusterOptions>,
): ClusterOutput[] {
  const similarityThreshold =
    opts?.similarityThreshold ?? DEFAULT_CLUSTER_OPTIONS.similarityThreshold;
  const maxStories =
    opts?.maxStories ?? DEFAULT_CLUSTER_OPTIONS.maxStories;
  // `opts?.random` is the only knob that introduces nondeterminism.
  // Production callers leave it unset; adversarial tests can inject it.
  const rng = opts?.random;

  if (inputs.length === 0) return [];

  const indexed = inputs.map((d) => ({
    documentId: d.documentId,
    representativeTopic: pickRepresentativeTopic(d.topics, rng),
  }));

  const parent = new Array<number>(indexed.length);
  for (let i = 0; i < indexed.length; i++) parent[i] = i;

  const find = (i: number): number => {
    let cur = i;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const sim = cosineSimilarity(
        inputs[i].embedding,
        inputs[j].embedding,
      );
      if (sim >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < indexed.length; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }

  const outputs: ClusterOutput[] = [];
  const usedLabels = new Set<string>();
  let storyIndex = 0;

  for (const members of groups.values()) {
    if (outputs.length >= maxStories) break;
    const topicCounts = new Map<string, number>();
    for (const idx of members) {
      const t = indexed[idx].representativeTopic;
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    let bestTopic = indexed[members[0]].representativeTopic;
    let bestCount = -1;
    for (const [t, c] of topicCounts) {
      if (c > bestCount) {
        bestCount = c;
        bestTopic = t;
      }
    }
    const label = makeLabel(bestTopic, storyIndex, usedLabels);
    storyIndex += 1;
    outputs.push({
      label,
      documentIds: members.map((m) => indexed[m].documentId),
    });
  }

  outputs.sort((a, b) => {
    if (b.documentIds.length !== a.documentIds.length) {
      return b.documentIds.length - a.documentIds.length;
    }
    return a.label.localeCompare(b.label);
  });

  const relabeled: ClusterOutput[] = outputs.map((o, i) => ({
    label: o.label,
    documentIds: o.documentIds,
  }));

  return relabeled;
}

export function cosineSimilarityForTest(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}
