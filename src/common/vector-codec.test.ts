import { describe, it, expect } from "vitest";
import { vectorToSql, sqlToVector } from "./vector-codec.js";

describe("vectorToSql", () => {
  it("converts a number array to pgvector string", () => {
    expect(vectorToSql([1, 2, 3])).toBe("[1,2,3]");
  });
  it("handles negative and fractional values", () => {
    expect(vectorToSql([-0.1, 0.5, 1.5])).toBe("[-0.1,0.5,1.5]");
  });
  it("handles empty array", () => {
    expect(vectorToSql([])).toBe("[]");
  });
});

describe("sqlToVector", () => {
  it("parses a pgvector string", () => {
    expect(sqlToVector("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("handles empty vector", () => {
    expect(sqlToVector("[]")).toEqual([]);
  });
  it("round-trips with vectorToSql", () => {
    const arr = [0.1, -0.2, 0.3, 0.4, 0.5];
    expect(sqlToVector(vectorToSql(arr))).toEqual(arr);
  });
});
