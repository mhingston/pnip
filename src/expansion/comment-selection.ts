import type { RedditComment } from "./reddit-plugin.js";

export type CommentSelectionStrategy =
  | "top-n"
  | "minimum-score"
  | "moderator"
  | "stickied";

export interface SelectCommentsOptions {
  strategy: CommentSelectionStrategy;
  limit?: number;
  minScore?: number;
}

function byScoreDesc(a: RedditComment, b: RedditComment): number {
  return (b.score ?? -Infinity) - (a.score ?? -Infinity);
}

function hasScores(comments: RedditComment[]): boolean {
  return comments.some((c) => typeof c.score === "number");
}

export function selectComments(
  comments: RedditComment[],
  opts: SelectCommentsOptions,
): RedditComment[] {
  const copy = [...comments];
  switch (opts.strategy) {
    case "top-n": {
      const limit = opts.limit ?? 25;
      if (hasScores(copy)) {
        return copy.sort(byScoreDesc).slice(0, limit);
      }
      return copy.slice(0, limit);
    }
    case "minimum-score": {
      if (!hasScores(copy)) return copy;
      const minScore = opts.minScore ?? 0;
      return copy.filter((c) => (c.score ?? -Infinity) >= minScore).sort(byScoreDesc);
    }
    case "moderator": {
      if (!copy.some((c) => typeof c.distinguished === "string")) return [];
      return copy
        .filter((c) => c.distinguished === "moderator" || c.distinguished === "admin")
        .sort(byScoreDesc);
    }
    case "stickied": {
      if (!copy.some((c) => typeof c.stickied === "boolean")) return [];
      return copy.filter((c) => c.stickied).sort(byScoreDesc);
    }
  }
}
