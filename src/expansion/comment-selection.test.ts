import { describe, it, expect } from "vitest";
import { selectComments } from "./comment-selection.js";
import type { RedditComment } from "./reddit-plugin.js";

function makeComment(
  overrides: Partial<RedditComment> & Pick<RedditComment, "id">,
): RedditComment {
  return {
    author: `u-${overrides.id}`,
    body: `body-${overrides.id}`,
    createdUtc: new Date(0),
    ...overrides,
  };
}

describe("selectComments", () => {
  const commentsWithScores: RedditComment[] = [
    makeComment({ id: "a", score: 10 }),
    makeComment({ id: "b", score: 50 }),
    makeComment({ id: "c", score: 30 }),
    makeComment({ id: "d", score: 20 }),
    makeComment({ id: "e", score: 40 }),
  ];

  const commentsWithoutScores: RedditComment[] = ["a", "b", "c", "d", "e"].map((id) =>
    makeComment({ id }),
  );

  it("top-n with undefined scores returns the first N comments in array order", () => {
    const result = selectComments(commentsWithoutScores, { strategy: "top-n", limit: 3 });
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("top-n with defined scores sorts by score desc and takes N", () => {
    const result = selectComments(commentsWithScores, { strategy: "top-n", limit: 3 });
    expect(result.map((c) => c.id)).toEqual(["b", "e", "c"]);
    expect(result.map((c) => c.score)).toEqual([50, 40, 30]);
  });

  it("top-n defaults limit to 25 when not specified", () => {
    const many = Array.from({ length: 30 }, (_, i) => makeComment({ id: `c${i}` }));
    const result = selectComments(many, { strategy: "top-n" });
    expect(result).toHaveLength(25);
    expect(result.map((c) => c.id)).toEqual(Array.from({ length: 25 }, (_, i) => `c${i}`));
  });

  it("minimum-score with undefined scores returns all (cannot filter)", () => {
    const result = selectComments(commentsWithoutScores, {
      strategy: "minimum-score",
      minScore: 25,
    });
    expect(result).toHaveLength(5);
  });

  it("minimum-score with defined scores filters by minScore", () => {
    const result = selectComments(commentsWithScores, {
      strategy: "minimum-score",
      minScore: 25,
    });
    expect(result.map((c) => c.id)).toEqual(["b", "e", "c"]);
  });

  it("moderator with undefined distinguished returns empty", () => {
    const result = selectComments(commentsWithoutScores, { strategy: "moderator" });
    expect(result).toEqual([]);
  });

  it("moderator with defined distinguished filters moderator and admin", () => {
    const modComments: RedditComment[] = [
      makeComment({ id: "m1", score: 5, distinguished: "moderator" }),
      makeComment({ id: "m2", score: 50, distinguished: "admin" }),
      makeComment({ id: "n1", score: 999, distinguished: null }),
      makeComment({ id: "m3", score: 20, distinguished: "moderator" }),
    ];
    const result = selectComments(modComments, { strategy: "moderator" });
    expect(result.map((c) => c.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("stickied with undefined stickied returns empty", () => {
    const result = selectComments(commentsWithoutScores, { strategy: "stickied" });
    expect(result).toEqual([]);
  });

  it("stickied with defined stickied filters sticky comments", () => {
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
