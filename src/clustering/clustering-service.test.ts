import { describe, it, expect } from "vitest";
import {
  clusterDocuments,
  cosineSimilarityForTest,
  type DocumentClusterInput,
  type ClusterRankingInput,
} from "./clustering-service.js";

function makeVector(values: number[]): number[] {
  return values;
}

function makeInput(
  id: string,
  topics: string[],
  vector: number[],
  publishedAt: Date | null = null,
  title?: string | null,
): DocumentClusterInput {
  return {
    documentId: id,
    summary: `Summary for ${id}`,
    topics,
    embedding: vector,
    publishedAt,
    title,
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = makeVector([1, 0, 0]);
    expect(cosineSimilarityForTest(v, v)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarityForTest([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarityForTest([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarityForTest([1, 0], [1, 0, 0])).toThrow(
      /dimension mismatch/,
    );
  });
});

describe("clusterDocuments", () => {
  it("returns empty array for empty input", () => {
    expect(clusterDocuments([])).toEqual([]);
  });

  it("groups documents whose embedding similarity is above threshold", () => {
    const a = makeVector([1, 0, 0]);
    const b = makeVector([0.99, 0.01, 0]);
    const inputs = [
      makeInput("d1", ["ai"], a),
      makeInput("d2", ["ai"], b),
    ];
    const result = clusterDocuments(inputs, {
      similarityThreshold: 0.9,
      random: () => 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0].documentIds).toHaveLength(2);
    expect(result[0].documentIds.sort()).toEqual(["d1", "d2"]);
  });

  it("separates documents whose embedding similarity is below threshold", () => {
    const a = makeVector([1, 0, 0]);
    const b = makeVector([0, 1, 0]);
    const inputs = [
      makeInput("d1", ["ai"], a),
      makeInput("d2", ["tech"], b),
    ];
    const result = clusterDocuments(inputs, {
      similarityThreshold: 0.9,
      random: () => 0,
    });
    expect(result).toHaveLength(2);
  });

  it("places every document in exactly one cluster", () => {
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0])),
      makeInput("d2", ["tech"], makeVector([0, 1])),
      makeInput("d3", ["ai"], makeVector([0.95, 0.05])),
    ];
    const result = clusterDocuments(inputs, {
      similarityThreshold: 0.9,
      random: () => 0,
    });
    const all = result.flatMap((c) => c.documentIds).sort();
    expect(all).toEqual(["d1", "d2", "d3"]);
  });

  it("produces deterministic labels for the same input", () => {
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0])),
      makeInput("d2", ["ai"], makeVector([1, 0])),
    ];
    const a = clusterDocuments(inputs, {
      similarityThreshold: 0.5,
      random: () => 0,
    });
    const b = clusterDocuments(inputs, {
      similarityThreshold: 0.5,
      random: () => 0,
    });
    expect(a[0].label).toBe(b[0].label);
  });

  it("orders clusters by descending size for digest stability", () => {
    const inputs = [
      makeInput("d1", ["tech"], makeVector([1, 0])),
      makeInput("d2", ["ai"], makeVector([0, 1])),
      makeInput("d3", ["ai"], makeVector([0, 1])),
    ];
    const result = clusterDocuments(inputs, {
      similarityThreshold: 0.99,
      random: () => 0,
    });
    expect(result[0].documentIds).toHaveLength(2);
    expect(result[1].documentIds).toHaveLength(1);
  });

  it("never exceeds maxStories", () => {
    const inputs = Array.from({ length: 10 }, (_, i) =>
      makeInput(`d${i}`, ["misc"], makeVector([Math.random(), Math.random()])),
    );
    const result = clusterDocuments(inputs, {
      similarityThreshold: 0.99,
      maxStories: 3,
      random: () => 0,
    });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  // Determinism audits — these intentionally use the DEFAULTS (Math.random,
  // no random override). They document the determinism contract that
  // callers outside this test file currently violate when they don't inject
  // `random: () => 0` (or some other stable seed). See M7-prep plan.

  it("picks the same representative topic for the same input across many runs (default RNG)", () => {
    // Multiple distinct topics should resolve to the FIRST deterministic tiebreak,
    // not to whatever Math.random() happens to return. With sorted tiebreak
    // (alphabetical) the first topic is "ai".
    const inputs = [
      makeInput("d1", ["ai", "ml", "tech"], makeVector([1, 0])),
    ];
    for (let run = 0; run < 8; run++) {
      const result = clusterDocuments(inputs, {
        similarityThreshold: 0.5,
      });
      expect(result[0]?.label).toMatch(/^story-ai-/);
    }
  });

  it("derives story labels from document titles when available", () => {
    const a = makeVector([1, 0, 0]);
    const b = makeVector([0.99, 0.01, 0]);
    const inputs = [
      makeInput("d1", ["ai"], a, null, "OpenAI Ships New Agent Framework"),
      makeInput("d2", ["ai"], b, null, "Deep Dive: OpenAI's Latest Release"),
    ];
    const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("OpenAI Ships New Agent Framework");
  });

  it("picks the shortest title for the label (punchy headlines preferred)", () => {
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0]), null, "AI Breakthrough"),
      makeInput("d2", ["ai"], makeVector([0.99, 0.01]), null, "Researchers Announce Major AI Breakthrough in Quantum Computing"),
    ];
    const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    expect(result[0].label).toBe("AI Breakthrough");
  });

  it("falls back to story-{topic}-{n} when no titles are available", () => {
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0])),
      makeInput("d2", ["ai"], makeVector([0.99, 0.01])),
    ];
    const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    expect(result[0].label).toMatch(/^story-ai-/);
  });

  it("falls back to story-{topic}-{n} when titles are empty or whitespace", () => {
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0]), null, "  "),
      makeInput("d2", ["ai"], makeVector([0.99, 0.01]), null, ""),
    ];
    const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    expect(result[0].label).toMatch(/^story-ai-/);
  });

  it("produces identical output for identical input across many runs (default RNG, no topic competition)", () => {
    // No topic competition → RNG only used by `pickRepresentativeTopic`'s
    // length-1 path which is `return deduped[0]`. Should be deterministic.
    const inputs = [
      makeInput("d1", ["ai"], makeVector([1, 0])),
      makeInput("d2", ["ai"], makeVector([0.99, 0.01])),
    ];
    const first = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    for (let run = 0; run < 8; run++) {
      const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
      expect(result[0]?.label).toBe(first[0]?.label);
    }
  });

  it("produces identical output for the same input in the same order (default RNG)", () => {
    // With Math.random as the RNG, identical input IN THE SAME ORDER must
    // be deterministic. This is what we want to guarantee even when callers
    // forget to pass `random`. (Today it happens to be deterministic for the
    // trivial reason of `pickRepresentativeTopic` using idx=Math.floor(rng()*1)
    // when topic arrays are length 1.)
    const inputs = Array.from({ length: 4 }, (_, i) =>
      makeInput(`d${i}`, ["tech"], makeVector([i, 0])),
    );
    const first = clusterDocuments(inputs, { similarityThreshold: 0.5 });
    for (let run = 0; run < 8; run++) {
      const result = clusterDocuments(inputs, { similarityThreshold: 0.5 });
      expect(result.map((c) => c.label)).toEqual(first.map((c) => c.label));
    }
  });

  describe("trust-tier re-ranking", () => {
    function makeInputWithSource(
      id: string,
      topics: string[],
      vector: number[],
      sourceIdentity?: string,
    ): DocumentClusterInput {
      return {
        documentId: id,
        summary: `Summary for ${id}`,
        topics,
        embedding: vector,
        publishedAt: null,
        sourceIdentity,
      };
    }

    it("no ranking input preserves the existing size-desc, label-asc order (regression guard)", () => {
      const inputs = [
        makeInput("d1", ["tech"], makeVector([1, 0])),
        makeInput("d2", ["ai"], makeVector([0, 1])),
        makeInput("d3", ["ai"], makeVector([0, 1])),
      ];
      const result = clusterDocuments(inputs, {
        similarityThreshold: 0.9,
        random: () => 0,
      });
      expect(result[0].documentIds.sort()).toEqual(["d2", "d3"]);
      expect(result[1].documentIds).toEqual(["d1"]);
    });

    it("ranking with trust tiers sorts higher-trust clusters first", () => {
      const inputs = [
        makeInputWithSource("d1", ["ai"], makeVector([1, 0]), "shady.com"),
        makeInputWithSource("d2", ["weather"], makeVector([0, 1]), "trusted.com"),
      ];
      const opts = { similarityThreshold: 0.9, random: () => 0 } as const;

      const baseline = clusterDocuments(inputs, opts);
      expect(baseline[0].documentIds).toEqual(["d1"]);

      const ranking: ClusterRankingInput = {
        sourceTrust: new Map([
          ["shady.com", 5],
          ["trusted.com", 1],
        ]),
        storyBias: new Map(),
      };
      const result = clusterDocuments(inputs, opts, ranking);
      expect(result[0].documentIds).toEqual(["d2"]);
      expect(result[1].documentIds).toEqual(["d1"]);
    });

    it("ranking with missing sourceIdentity on some inputs treats them as default tier 3", () => {
      const inputs = [
        makeInputWithSource("d1", ["ai"], makeVector([1, 0])),
        makeInputWithSource("d2", ["ml"], makeVector([0, 1]), "unrated.com"),
        makeInputWithSource("d3", ["weather"], makeVector([0.5, 0.5]), "trusted.com"),
      ];
      const opts = { similarityThreshold: 0.9, random: () => 0 } as const;
      const ranking: ClusterRankingInput = {
        sourceTrust: new Map([["trusted.com", 1]]),
        storyBias: new Map(),
      };
      const result = clusterDocuments(inputs, opts, ranking);
      const trustedCluster = result.find((c) => c.documentIds.includes("d3"));
      const d1Cluster = result.find((c) => c.documentIds.includes("d1"));
      const d2Cluster = result.find((c) => c.documentIds.includes("d2"));
      expect(result.indexOf(trustedCluster!)).toBeLessThan(result.indexOf(d1Cluster!));
      expect(result.indexOf(d1Cluster!)).toBeLessThan(result.indexOf(d2Cluster!));
    });

    it("ranking with an empty sourceTrust map yields the same order as no ranking", () => {
      const inputs = [
        makeInput("d1", ["tech"], makeVector([1, 0])),
        makeInput("d2", ["ai"], makeVector([0, 1])),
        makeInput("d3", ["ai"], makeVector([0, 1])),
      ];
      const opts = { similarityThreshold: 0.9, random: () => 0 } as const;
      const baseline = clusterDocuments(inputs, opts);
      const ranking: ClusterRankingInput = {
        sourceTrust: new Map(),
        storyBias: new Map(),
      };
      const result = clusterDocuments(inputs, opts, ranking);
      expect(result.map((c) => c.label)).toEqual(baseline.map((c) => c.label));
      expect(result.map((c) => c.documentIds)).toEqual(
        baseline.map((c) => c.documentIds),
      );
    });
  });
});
