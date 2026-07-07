import { describe, it, expect } from "vitest";
import { selectComments } from "./comment-selection.js";
import type { RedditComment } from "./reddit-plugin.js";

function makeComment(
  overrides: Partial<RedditComment> & Pick<RedditComment, "id" | "score">,
): RedditComment {
  return {
    author: `u-${overrides.id}`,
    body: `body-${overrides.id}`,
    createdUtc: new Date(0),
    stickied: false,
    isSubmitter: false,
    distinguished: null,
    replies: [],
    ...overrides,
  };
}

describe("selectComments", () => {
  const comments: RedditComment[] = [
    makeComment({ id: "a", score: 10 }),
    makeComment({ id: "b", score: 50 }),
    makeComment({ id: "c", score: 30 }),
    makeComment({ id: "d", score: 20 }),
    makeComment({ id: "e", score: 40 }),
  ];

  it("top-n returns the N highest-scoring comments sorted by score desc", () => {
    const result = selectComments(comments, { strategy: "top-n", limit: 3 });
    expect(result.map((c) => c.id)).toEqual(["b", "e", "c"]);
    expect(result.map((c) => c.score)).toEqual([50, 40, 30]);
  });

  it("top-n defaults limit to 25 when not specified", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeComment({ id: `c${i}`, score: i }),
    );
    const result = selectComments(many, { strategy: "top-n" });
    expect(result).toHaveLength(25);
    expect(result[0].score).toBe(29);
  });

  it("minimum-score returns comments with score >= minScore sorted desc", () => {
    const result = selectComments(comments, {
      strategy: "minimum-score",
      minScore: 25,
    });
    expect(result.map((c) => c.id)).toEqual(["b", "e", "c"]);
  });

  it("minimum-score defaults minScore to 0", () => {
    const result = selectComments(comments, { strategy: "minimum-score" });
    expect(result).toHaveLength(5);
    expect(result[0].score).toBe(50);
  });

  it("moderator returns only moderator and admin comments sorted desc", () => {
    const modComments: RedditComment[] = [
      makeComment({ id: "m1", score: 5, distinguished: "moderator" }),
      makeComment({ id: "m2", score: 50, distinguished: "admin" }),
      makeComment({ id: "n1", score: 999, distinguished: null }),
      makeComment({ id: "m3", score: 20, distinguished: "moderator" }),
    ];
    const result = selectComments(modComments, { strategy: "moderator" });
    expect(result.map((c) => c.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("stickied returns only stickied comments sorted desc", () => {
    const stickyComments: RedditComment[] = [
      makeComment({ id: "s1", score: 5, stickied: true }),
      makeComment({ id: "n1", score: 999, stickied: false }),
      makeComment({ id: "s2", score: 50, stickied: true }),
    ];
    const result = selectComments(stickyComments, { strategy: "stickied" });
    expect(result.map((c) => c.id)).toEqual(["s2", "s1"]);
  });

  it("returns an empty array for empty input across all strategies", () => {
    expect(selectComments([], { strategy: "top-n" })).toEqual([]);
    expect(selectComments([], { strategy: "minimum-score" })).toEqual([]);
    expect(selectComments([], { strategy: "moderator" })).toEqual([]);
    expect(selectComments([], { strategy: "stickied" })).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [makeComment({ id: "a", score: 1 }), makeComment({ id: "b", score: 2 })];
    const snapshot = input.map((c) => ({ ...c }));
    selectComments(input, { strategy: "top-n", limit: 1 });
    expect(input).toEqual(snapshot);
  });
});
