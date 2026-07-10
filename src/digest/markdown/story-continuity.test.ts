import { describe, expect, it } from "vitest";
import { classifyStoryContinuity } from "./story-continuity.js";

describe("classifyStoryContinuity", () => {
  it("explains continuity when editions share the same canonical source", () => {
    expect(classifyStoryContinuity(
      { label: "OpenAI releases agent update", urls: ["https://example.com/update"] },
      [{ label: "Earlier coverage", urls: ["https://example.com/update"] }],
    )).toEqual({ kind: "continuing", previousStoryLabel: "Earlier coverage", reason: "shared_source" });
  });

  it("conservatively matches a sufficiently specific identical label", () => {
    expect(classifyStoryContinuity(
      { label: "OpenAI releases a new coding agent", urls: [] },
      [{ label: "openai releases a new coding agent!", urls: [] }],
    )).toMatchObject({ kind: "continuing", reason: "same_specific_label" });
  });

  it("does not label merely similar topics or short generic labels as repeats", () => {
    const previous = [{ label: "New AI model", urls: ["https://a.test/one"] }];
    expect(classifyStoryContinuity(
      { label: "New AI model", urls: ["https://b.test/two"] }, previous,
    )).toEqual({ kind: "new" });
    expect(classifyStoryContinuity(
      { label: "Anthropic releases a new reasoning model", urls: [] },
      [{ label: "OpenAI releases a new reasoning model", urls: [] }],
    )).toEqual({ kind: "new" });
  });
});
