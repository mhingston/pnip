import { describe, expect, it } from "vitest";
import type { MinifluxEntry } from "./miniflux-client.js";
import {
  classifyDiscoverySourceFamily,
  parseBookmarkIdFragment,
  resolveDiscoverySourceFamily,
  selectBalancedEntries,
} from "./source-coverage.js";

function entry(id: number, url: string, feedId = 1): MinifluxEntry {
  return { id, feedId, title: `Entry ${id}`, url };
}

describe("source coverage", () => {
  it("classifies Reddit and YouTube URLs before expansion", () => {
    expect(classifyDiscoverySourceFamily("https://www.reddit.com/r/example/1")).toBe("reddit");
    expect(classifyDiscoverySourceFamily("https://youtu.be/video")).toBe("youtube");
    expect(classifyDiscoverySourceFamily("https://blog.example.com/post")).toBe("article");
  });

  it("returns read-later for entries from a configured bridge feed id", () => {
    const readLater = new Set([42]);
    expect(
      resolveDiscoverySourceFamily({
        url: "https://example.com/post",
        feedId: 42,
        readLaterFeedIds: readLater,
      }),
    ).toBe("read-later");
    expect(
      resolveDiscoverySourceFamily({
        url: "https://www.youtube.com/watch?v=1",
        feedId: 42,
        readLaterFeedIds: readLater,
      }),
    ).toBe("read-later");
  });

  it("falls back to URL classification when the feed isn't a bridge feed", () => {
    const readLater = new Set([42]);
    expect(
      resolveDiscoverySourceFamily({
        url: "https://www.youtube.com/watch?v=1",
        feedId: 7,
        readLaterFeedIds: readLater,
      }),
    ).toBe("youtube");
  });

  it("treats an empty read-later set as no overrides", () => {
    expect(
      resolveDiscoverySourceFamily({
        url: "https://example.com/post",
        feedId: 42,
        readLaterFeedIds: new Set(),
      }),
    ).toBe("article");
  });

  it("round-trips bookmark ids through the URL fragment helper", () => {
    expect(parseBookmarkIdFragment("https://example.com/post#rb=12345")).toBe(12345);
    expect(parseBookmarkIdFragment("https://example.com/post?x=1#section&rb=99")).toBe(99);
  });

  it("returns undefined when the fragment is absent or malformed", () => {
    expect(parseBookmarkIdFragment("https://example.com/post")).toBeUndefined();
    expect(parseBookmarkIdFragment("https://example.com/post#rb=-1")).toBeUndefined();
    expect(parseBookmarkIdFragment("https://example.com/post#rb=abc")).toBeUndefined();
    expect(parseBookmarkIdFragment("https://example.com/post#other=1")).toBeUndefined();
  });

  it("prioritizes articles and YouTube before using Reddit as fallback", () => {
    const entries = [
      entry(10, "https://www.youtube.com/watch?v=10"),
      entry(9, "https://www.youtube.com/watch?v=9"),
      entry(8, "https://blog.example.com/8"),
      entry(7, "https://www.reddit.com/r/example/7"),
      entry(6, "https://www.youtube.com/watch?v=6"),
      entry(5, "https://blog.example.com/5"),
    ];

    const selected = selectBalancedEntries(entries, 4);

    expect(selected.map((item) => item.id)).toEqual([5, 8, 9, 10]);
    expect(selected.map((item) => classifyDiscoverySourceFamily(item.url))).toEqual([
      "article",
      "article",
      "youtube",
      "youtube",
    ]);

    expect(
      selectBalancedEntries(entries, 5).map((item) => item.id),
    ).toEqual([5, 7, 8, 9, 10]);
  });

  it("can preserve newest-first selection when balancing is disabled", () => {
    const selected = selectBalancedEntries(
      [
        entry(1, "https://blog.example.com/1"),
        entry(3, "https://www.youtube.com/watch?v=3"),
        entry(2, "https://www.reddit.com/r/example/2"),
      ],
      2,
      false,
    );
    expect(selected.map((item) => item.id)).toEqual([2, 3]);
  });
});
