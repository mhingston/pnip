import { describe, it, expect } from "vitest";
import {
  buildCitationIndex,
  citationToken,
  citationTokenFor,
} from "./citation-index.js";

describe("buildCitationIndex", () => {
  it("returns empty index for no citations", () => {
    const idx = buildCitationIndex([]);
    expect(idx.entries).toEqual([]);
    expect([...idx.byChunkId.entries()]).toEqual([]);
  });

  it("assigns contiguous 1-based numbers in insertion order", () => {
    const idx = buildCitationIndex([
      { chunkId: "doc1-chunk-A", claimText: "x" },
      { chunkId: "doc1-chunk-B", claimText: "y" },
      { chunkId: "doc2-chunk-A", claimText: "z" },
    ]);
    expect(idx.entries.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(idx.byChunkId.get("doc1-chunk-A")).toBe(1);
    expect(idx.byChunkId.get("doc1-chunk-B")).toBe(2);
    expect(idx.byChunkId.get("doc2-chunk-A")).toBe(3);
  });

  it("deduplicates repeated chunk ids across citations", () => {
    const idx = buildCitationIndex([
      { chunkId: "c1", claimText: "a" },
      { chunkId: "c1", claimText: "a-again" },
      { chunkId: "c2", claimText: "b" },
    ]);
    expect(idx.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(idx.byChunkId.get("c1")).toBe(1);
    expect(idx.byChunkId.get("c2")).toBe(2);
  });

  it("is deterministic for the same input order", () => {
    const input = [
      { chunkId: "doc1-chunk-A", claimText: "x" },
      { chunkId: "doc1-chunk-B", claimText: "y" },
    ];
    const a = buildCitationIndex(input);
    const b = buildCitationIndex(input);
    expect([...a.byChunkId.entries()]).toEqual([...b.byChunkId.entries()]);
    expect(a.entries.map((e) => e.number)).toEqual(b.entries.map((e) => e.number));
  });

  it("is sensitive to first-appearance order but stable across re-runs of the same order", () => {
    const a = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c2", claimText: "y" },
    ]);
    const b = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c2", claimText: "y" },
    ]);
    expect([...a.byChunkId.entries()]).toEqual([...b.byChunkId.entries()]);
  });

  it("is robust to re-ordering of duplicates after first appearance", () => {
    const a = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c2", claimText: "y" },
    ]);
    const b = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c1", claimText: "x-again" },
      { chunkId: "c2", claimText: "y" },
      { chunkId: "c2", claimText: "y-again" },
    ]);
    expect([...a.byChunkId.entries()]).toEqual([...b.byChunkId.entries()]);
  });

  it("produces different numbering when the first-appearance order differs", () => {
    const a = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c2", claimText: "y" },
    ]);
    const b = buildCitationIndex([
      { chunkId: "c2", claimText: "y" },
      { chunkId: "c1", claimText: "x" },
    ]);
    expect(a.byChunkId.get("c1")).toBe(1);
    expect(a.byChunkId.get("c2")).toBe(2);
    expect(b.byChunkId.get("c1")).toBe(2);
    expect(b.byChunkId.get("c2")).toBe(1);
  });

  it("renumbers entries after deduplication to be contiguous from 1", () => {
    const idx = buildCitationIndex([
      { chunkId: "c1", claimText: "x" },
      { chunkId: "c1", claimText: "y" },
      { chunkId: "c2", claimText: "z" },
    ]);
    expect(idx.byChunkId.get("c1")).toBe(1);
    expect(idx.byChunkId.get("c2")).toBe(2);
    expect(idx.entries.map((e) => e.chunkId)).toEqual(["c1", "c2"]);
  });
});

describe("citationToken / citationTokenFor", () => {
  it("citationToken returns the [N] form", () => {
    expect(citationToken(1)).toBe("[1]");
    expect(citationToken(42)).toBe("[42]");
  });

  it("citationTokenFor resolves a known chunk id", () => {
    const idx = buildCitationIndex([
      { chunkId: "doc1", claimText: "x" },
      { chunkId: "doc2", claimText: "y" },
    ]);
    expect(citationTokenFor(idx, "doc1")).toBe("[1]");
    expect(citationTokenFor(idx, "doc2")).toBe("[2]");
  });

  it("citationTokenFor throws on an unknown chunk id", () => {
    const idx = buildCitationIndex([{ chunkId: "doc1", claimText: "x" }]);
    expect(() => citationTokenFor(idx, "missing")).toThrow(/missing/);
  });
});
