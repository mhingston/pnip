export class RedditRateLimitError extends Error {
  constructor(public resetSeconds: number) {
    super(`reddit rate limited, resets in ${resetSeconds}s`);
    this.name = "RedditRateLimitError";
  }
}

export type RssFetcher = (url: string) => Promise<string>;

export function createDefaultRssFetcher(userAgent?: string): RssFetcher {
  return async (url: string): Promise<string> => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent ?? "PNIP/1.0",
        Accept: "application/rss+xml",
      },
    });
    const remainingHeader = res.headers.get("x-ratelimit-remaining");
    const resetHeader = res.headers.get("x-ratelimit-reset");
    const remaining = remainingHeader !== null ? parseFloat(remainingHeader) : NaN;
    const resetSeconds = resetHeader !== null ? parseInt(resetHeader, 10) : 60;
    if (res.status === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
      throw new RedditRateLimitError(Number.isFinite(resetSeconds) ? resetSeconds : 60);
    }
    if (!res.ok) {
      throw new Error(`reddit RSS fetch failed: HTTP ${res.status}`);
    }
    return res.text();
  };
}
