import { describe, it, expect } from "vitest";
import {
  clusterDocuments,
  cosineSimilarityForTest,
  type DocumentClusterInput,
} from "./clustering-service.js";

function makeVector(values: number[]): number[] {
  return values;
}

function makeInput(
  id: string,
  topics: string[],
  vector: number[],
  publishedAt: Date | null = null,
): DocumentClusterInput {
  return {
    documentId: id,
    summary: `Summary for ${id}`,
    topics,
    embedding: vector,
    publishedAt,
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
});
