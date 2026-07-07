import { describe, it, expect } from "vitest";
import { extractJson } from "./json-extract.js";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    const r = extractJson<{ a: number }>('{"a": 1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it("extracts JSON from surrounding prose", () => {
    const r = extractJson<{ summary: string }>(
      'Here is the summary: {"summary": "hello"} -- end',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ summary: "hello" });
  });

  it("handles nested braces", () => {
    const r = extractJson<{ a: { b: number } }>('prefix {"a": {"b": 2}} suffix');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: { b: 2 } });
  });

  it("returns an error when no JSON object is present", () => {
    const r = extractJson("just plain text");
    expect(r.ok).toBe(false);
  });

  it("returns an error when JSON is malformed", () => {
    const r = extractJson('{"a": }');
    expect(r.ok).toBe(false);
  });
});
