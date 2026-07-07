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
  return b.score - a.score;
}

export function selectComments(
  comments: RedditComment[],
  opts: SelectCommentsOptions,
): RedditComment[] {
  const copy = [...comments];
  switch (opts.strategy) {
    case "top-n": {
      const limit = opts.limit ?? 25;
      return copy.sort(byScoreDesc).slice(0, limit);
    }
    case "minimum-score": {
      const minScore = opts.minScore ?? 0;
      return copy.filter((c) => c.score >= minScore).sort(byScoreDesc);
    }
    case "moderator": {
      return copy
        .filter((c) => c.distinguished === "moderator" || c.distinguished === "admin")
        .sort(byScoreDesc);
    }
    case "stickied": {
      return copy.filter((c) => c.stickied).sort(byScoreDesc);
    }
  }
}
