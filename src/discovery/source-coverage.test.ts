import { describe, expect, it } from "vitest";
import type { MinifluxEntry } from "./miniflux-client.js";
import {
  classifyDiscoverySourceFamily,
  selectBalancedEntries,
} from "./source-coverage.js";

function entry(id: number, url: string): MinifluxEntry {
  return { id, feedId: 1, title: `Entry ${id}`, url };
}

describe("source coverage", () => {
  it("classifies Reddit and YouTube URLs before expansion", () => {
    expect(classifyDiscoverySourceFamily("https://www.reddit.com/r/example/1")).toBe("reddit");
    expect(classifyDiscoverySourceFamily("https://youtu.be/video")).toBe("youtube");
    expect(classifyDiscoverySourceFamily("https://blog.example.com/post")).toBe("article");
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
