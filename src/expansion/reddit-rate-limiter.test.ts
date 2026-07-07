import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDefaultRssFetcher,
  RedditRateLimitError,
  type RssFetcher,
} from "./reddit-rate-limiter.js";

function fakeResponse(opts: {
  status?: number;
  body?: string;
  remaining?: string;
  reset?: string;
  used?: string;
}) {
  const headers = new Map<string, string>();
  if (opts.remaining !== undefined) headers.set("x-ratelimit-remaining", opts.remaining);
  if (opts.reset !== undefined) headers.set("x-ratelimit-reset", opts.reset);
  if (opts.used !== undefined) headers.set("x-ratelimit-used", opts.used);
  return {
    ok: opts.status === undefined || (opts.status >= 200 && opts.status < 300),
    status: opts.status ?? 200,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    text: async () => opts.body ?? "",
  };
}

describe("createDefaultRssFetcher", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the response body when status is 200 and remaining > 0", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ status: 200, body: "<feed/>", remaining: "100.0", reset: "600" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const fetcher: RssFetcher = createDefaultRssFetcher("PNIP/1.0");
    const body = await fetcher("https://www.reddit.com/r/x/comments/i/s/.rss");

    expect(body).toBe("<feed/>");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("PNIP/1.0");
    expect(headers["Accept"]).toBe("application/rss+xml");
  });

  it("uses default User-Agent when none provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ status: 200, body: "x", remaining: "5", reset: "10" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const fetcher = createDefaultRssFetcher();
    await fetcher("https://example.com/.rss");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("PNIP/1.0");
  });

  it("throws RedditRateLimitError when x-ratelimit-remaining is 0", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 200, body: "", remaining: "0.0", reset: "45" }),
    ) as unknown as typeof globalThis.fetch;

    const fetcher = createDefaultRssFetcher();
    await expect(fetcher("https://example.com/.rss")).rejects.toMatchObject({
      name: "RedditRateLimitError",
      resetSeconds: 45,
    });
  });

  it("throws RedditRateLimitError on 429 with reset header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 429, remaining: "0.0", reset: "49" }),
    ) as unknown as typeof globalThis.fetch;

    const fetcher = createDefaultRssFetcher();
    await expect(fetcher("https://example.com/.rss")).rejects.toMatchObject({
      name: "RedditRateLimitError",
      resetSeconds: 49,
    });
  });

  it("defaults resetSeconds to 60 when header missing on rate limit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 429, remaining: "0.0" }),
    ) as unknown as typeof globalThis.fetch;

    const fetcher = createDefaultRssFetcher();
    await expect(fetcher("https://example.com/.rss")).rejects.toMatchObject({
      name: "RedditRateLimitError",
      resetSeconds: 60,
    });
  });

  it("throws generic Error on non-OK non-429 status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 500, remaining: "100", reset: "10" }),
    ) as unknown as typeof globalThis.fetch;

    const fetcher = createDefaultRssFetcher();
    await expect(fetcher("https://example.com/.rss")).rejects.toThrow(
      /reddit RSS fetch failed: HTTP 500/,
    );
  });

  it("RedditRateLimitError is an Error subclass with resetSeconds", () => {
    const err = new RedditRateLimitError(30);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RedditRateLimitError");
    expect(err.resetSeconds).toBe(30);
    expect(err.message).toContain("30");
  });
});
