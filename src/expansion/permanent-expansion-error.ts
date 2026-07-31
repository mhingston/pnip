/**
 * Error type for expansion failures that are guaranteed to keep failing on
 * every retry. Surfaced from expansion plugins (e.g. when a YouTube video
 * has no captions, or fabric exits because there is nothing to transcribe)
 * so the worker runtime can mark the job permanently failed without
 * burning the full retry budget.
 */
export class PermanentExpansionError extends Error {
  readonly isPermanentExpansionError = true;

  constructor(message: string) {
    super(message);
    this.name = "PermanentExpansionError";
  }
}

export function isPermanentExpansionError(err: unknown): err is PermanentExpansionError {
  return (
    err instanceof PermanentExpansionError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { isPermanentExpansionError?: unknown }).isPermanentExpansionError === true)
  );
}

/**
 * fabric surfaces its failures on stderr. We can't trust it to exit with a
 * distinct code per failure class, so we pattern-match the most common
 * "this video has nothing to give us" diagnostics. A match means retrying
 * the same fabric command will produce the same result.
 */
const PERMANENT_FABRIC_DIAGNOSTIC_RE =
  /\bno VTT files?\b|\bno automatic captions\b|\bno subtitles\b|\bno transcript\b|\bvideo (?:is )?(?:unavailable|not available|removed|private)\b|\bcould not find video\b|\bSign in to confirm you.?re not a bot\b/i;

export function looksLikePermanentFabricFailure(
  message: string | undefined,
  stderr: string | undefined,
): boolean {
  const haystacks = [message ?? "", stderr ?? ""];
  return haystacks.some((s) => s.length > 0 && PERMANENT_FABRIC_DIAGNOSTIC_RE.test(s));
}
