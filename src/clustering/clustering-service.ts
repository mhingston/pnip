export interface DocumentClusterInput {
  documentId: string;
  summary: string;
  topics: string[];
  embedding: number[];
  publishedAt: Date | null;
  sourceIdentity?: string;
  /** Optional per-document editorial boost, applied after source trust. */
  sourcePriorityBoost?: number;
  title?: string | null;
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
  /** Editions at or below this document count use the small-edition threshold. */
  smallEditionMaxDocuments?: number;
  /** More permissive similarity threshold for small editions. */
  smallEditionSimilarityThreshold?: number;
  /**
   * Fraction of documentCount that becomes the target story count when
   * the caller does not pin `targetStories` directly. Clamped to [4, 50].
   * `0.6` × 11 docs → 7 stories, `0.6` × 50 → 30 stories.
   */
  targetStoriesRatio?: number;
  /**
   * Optional explicit target story count. Overrides the ratio-based
   * computation when set. The greedy merge stops once cluster count <= this
   * value, so a value >= documentCount degenerates to one-doc-per-cluster.
   */
  targetStories?: number;
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

export interface ClusterRankingInput {
  sourceTrust: Map<string, number>;
  storyBias: Map<string, number>;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  similarityThreshold: 0.65,
  minClusterSize: 1,
  maxStories: 100,
  smallEditionMaxDocuments: 24,
  smallEditionSimilarityThreshold: 0.55,
  targetStoriesRatio: 0.6,
};

export function resolveSimilarityThreshold(
  documentCount: number,
  opts?: Partial<ClusterOptions>,
): number {
  // An explicit threshold always wins, which keeps callers/tests that need a
  // fixed clustering policy deterministic.
  if (opts?.similarityThreshold !== undefined) {
    return opts.similarityThreshold;
  }
  const maxDocuments =
    opts?.smallEditionMaxDocuments ??
    DEFAULT_CLUSTER_OPTIONS.smallEditionMaxDocuments!;
  if (documentCount > 0 && documentCount <= maxDocuments) {
    return (
      opts?.smallEditionSimilarityThreshold ??
      DEFAULT_CLUSTER_OPTIONS.smallEditionSimilarityThreshold!
    );
  }
  return DEFAULT_CLUSTER_OPTIONS.similarityThreshold;
}

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

function computeTargetStories(
  docCount: number,
  opts: { targetStories?: number; targetStoriesRatio?: number },
): number {
  if (opts.targetStories !== undefined) {
    return Math.max(1, Math.min(docCount, Math.floor(opts.targetStories)));
  }
  const ratio = opts.targetStoriesRatio ?? DEFAULT_CLUSTER_OPTIONS.targetStoriesRatio!;
  const raw = Math.round(docCount * ratio);
  const clamped = Math.max(4, Math.min(50, raw));
  return Math.max(1, Math.min(docCount, clamped));
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
  titles: string[],
): string {
  let base: string;
  if (titles.length > 0) {
    const sorted = [...titles].sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    );
    base = sorted[0]!;
    if (base.length > 100) base = base.slice(0, 99) + "\u2026";
  } else {
    base = `story-${topic}-${index + 1}`.toLowerCase().replace(/\s+/g, "-");
  }
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

interface EmbeddingIndex {
  ids: string[];
  vectors: number[][];
}

interface MergeCandidate {
  i: number;
  j: number;
  sim: number;
}

function computeAllPairs(emb: EmbeddingIndex): MergeCandidate[] {
  const out: MergeCandidate[] = [];
  for (let i = 0; i < emb.ids.length; i++) {
    for (let j = i + 1; j < emb.ids.length; j++) {
      const sim = cosineSimilarity(emb.vectors[i]!, emb.vectors[j]!);
      out.push({ i, j, sim });
    }
  }
  return out;
}

function averageLink(
  a: number[],
  b: number[],
  emb: EmbeddingIndex,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const i of a) {
    for (const j of b) {
      sum += cosineSimilarity(emb.vectors[i]!, emb.vectors[j]!);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export function clusterDocuments(
  inputs: readonly DocumentClusterInput[],
  opts?: Partial<ClusterOptions>,
  ranking?: ClusterRankingInput,
): ClusterOutput[] {
  const similarityThreshold = resolveSimilarityThreshold(inputs.length, opts);
  const maxStories =
    opts?.maxStories ?? DEFAULT_CLUSTER_OPTIONS.maxStories;
  const targetStories = computeTargetStories(inputs.length, {
    targetStories: opts?.targetStories,
    targetStoriesRatio:
      opts?.targetStoriesRatio ?? DEFAULT_CLUSTER_OPTIONS.targetStoriesRatio,
  });
  const rng = opts?.random;

  if (inputs.length === 0) return [];

  const indexed = inputs.map((d) => ({
    documentId: d.documentId,
    title: d.title ?? null,
    representativeTopic: pickRepresentativeTopic(d.topics, rng),
  }));

  const emb: EmbeddingIndex = {
    ids: indexed.map((d) => d.documentId),
    vectors: inputs.map((d) => d.embedding),
  };

  const candidates = computeAllPairs(emb);
  candidates.sort((a, b) => b.sim - a.sim || a.i - b.i || a.j - b.j);

  const clusters: number[][] = indexed.map((_, i) => [i]);
  const clusterOf = new Array<number>(indexed.length);
  for (let i = 0; i < indexed.length; i++) clusterOf[i] = i;

  for (const c of candidates) {
    if (c.sim < similarityThreshold) break;
    if (clusters.length <= targetStories) break;
    const rootI = clusterOf[c.i]!;
    const rootJ = clusterOf[c.j]!;
    if (rootI === rootJ) continue;
    const avg = averageLink(clusters[rootI]!, clusters[rootJ]!, emb);
    if (avg < similarityThreshold) continue;
    if (clusters.length <= targetStories) break;
    const merged: number[] = clusters[rootI]!.concat(clusters[rootJ]!);
    const keepIdx = rootI < rootJ ? rootI : rootJ;
    const dropIdx = rootI < rootJ ? rootJ : rootI;
    for (const idx of clusters[dropIdx]!) clusterOf[idx] = keepIdx;
    clusters[keepIdx] = merged;
    clusters.splice(dropIdx, 1);
    for (let k = 0; k < indexed.length; k++) {
      if (clusterOf[k]! > dropIdx) clusterOf[k] = clusterOf[k]! - 1;
    }
  }

  const outputs: ClusterOutput[] = [];
  const usedLabels = new Set<string>();
  let storyIndex = 0;

  for (const members of clusters) {
    if (outputs.length >= maxStories) break;
    const topicCounts = new Map<string, number>();
    for (const idx of members) {
      const t = indexed[idx].representativeTopic;
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    let bestTopic = indexed[members[0]!]!.representativeTopic;
    let bestCount = -1;
    for (const [t, c] of topicCounts) {
      if (c > bestCount) {
        bestCount = c;
        bestTopic = t;
      }
    }
    const memberTitles = members
      .map((idx) => indexed[idx]!.title)
      .filter((t): t is string => t !== null && t.trim().length > 0)
      .map((t) => t.trim());
    const label = makeLabel(bestTopic, storyIndex, usedLabels, memberTitles);
    storyIndex += 1;
    outputs.push({
      label,
      documentIds: members.map((m) => indexed[m]!.documentId),
    });
  }

  if (ranking) {
    const docIdToSourceIdentity = new Map<string, string | undefined>();
    const docIdToInput = new Map<string, DocumentClusterInput>();
    for (const inp of inputs) {
      docIdToSourceIdentity.set(inp.documentId, inp.sourceIdentity);
      docIdToInput.set(inp.documentId, inp);
    }
    const trustScore = (cluster: ClusterOutput): { sum: number; count: number } => {
      let sum = 0;
      for (const docId of cluster.documentIds) {
        const identity = docIdToSourceIdentity.get(docId);
        const tier = identity ? ranking.sourceTrust.get(identity) ?? 3 : 3;
        const input = docIdToInput.get(docId);
        sum += 6 - tier + (input?.sourcePriorityBoost ?? 0);
      }
      return { sum, count: cluster.documentIds.length };
    };
    const scored = outputs.map((c) => ({ cluster: c, s: trustScore(c) }));
    scored.sort((a, b) => {
      const left = a.s.sum * b.s.count;
      const right = b.s.sum * a.s.count;
      if (left !== right) return right - left;
      if (b.s.count !== a.s.count) return b.s.count - a.s.count;
      return a.cluster.label.localeCompare(b.cluster.label);
    });
    outputs.splice(0, outputs.length, ...scored.map((s) => s.cluster));
  } else {
    outputs.sort((a, b) => {
      if (b.documentIds.length !== a.documentIds.length) {
        return b.documentIds.length - a.documentIds.length;
      }
      return a.label.localeCompare(b.label);
    });
  }

  const relabeled: ClusterOutput[] = outputs.map((o) => ({
    label: o.label,
    documentIds: o.documentIds,
  }));

  return relabeled;
}

export function cosineSimilarityForTest(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}
