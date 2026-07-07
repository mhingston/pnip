import { describe, it, expect } from "vitest";
import { createFakeEmbeddingProvider } from "./fake-embedding-provider.js";

describe("FakeEmbeddingProvider", () => {
  it("returns a vector per input text with the configured dimension", async () => {
    const p = createFakeEmbeddingProvider({ dimension: 16 });
    const result = await p.embed(["hello", "world", "again"]);
    expect(result.vectors).toHaveLength(3);
    expect(result.vectors[0]).toHaveLength(16);
    expect(result.vectors[1]).toHaveLength(16);
    expect(result.dimension).toBe(16);
    expect(result.provider).toBe("fake");
  });

  it("is deterministic for the same input", async () => {
    const p = createFakeEmbeddingProvider({ dimension: 8 });
    const a = await p.embed(["hello"]);
    const b = await p.embed(["hello"]);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  it("returns different vectors for different inputs", async () => {
    const p = createFakeEmbeddingProvider({ dimension: 8 });
    const r = await p.embed(["a", "b"]);
    expect(r.vectors[0]).not.toEqual(r.vectors[1]);
  });

  it("handles empty input", async () => {
    const p = createFakeEmbeddingProvider();
    const r = await p.embed([]);
    expect(r.vectors).toEqual([]);
  });
});
