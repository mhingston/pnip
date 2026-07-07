import { describe, it, expect, vi } from "vitest";
import {
  createYouTubePlugin,
  parseTranscript,
  buildTranscriptSections,
  extractVideoId,
  type TranscriptFetcher,
  type MetadataFetcher,
  type YouTubeMetadata,
  type TranscriptSegment,
} from "./youtube-plugin.js";
import type { ExpandContext } from "./types.js";

const ctx: ExpandContext = {
  url: "https://www.youtube.com/watch?v=aircAruvnKk",
  editionId: "e1",
  discoveryEventId: "d1",
};

const sampleTranscript =
  "[00:00:00] [Music]\n[00:00:04] Hello world\n[00:01:30] Goodbye";

function makeSegments(n: number): TranscriptSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * 5,
    text: `line ${i}`,
  }));
}

describe("YouTubePlugin.supports", () => {
  const plugin = createYouTubePlugin();

  it("matches youtube.com/watch", () => {
    expect(plugin.supports("https://www.youtube.com/watch?v=abc123")).toBe(true);
  });

  it("matches youtu.be/", () => {
    expect(plugin.supports("https://youtu.be/abc123")).toBe(true);
  });

  it("matches youtube.com/embed/", () => {
    expect(plugin.supports("https://www.youtube.com/embed/abc123")).toBe(true);
  });

  it("rejects example.com article", () => {
    expect(plugin.supports("https://example.com/article")).toBe(false);
  });

  it("rejects reddit.com", () => {
    expect(plugin.supports("https://reddit.com/r/test")).toBe(false);
  });
});

describe("extractVideoId", () => {
  it("extracts v= query param (ignoring trailing params)", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=aircAruvnKk&t=10s")).toBe(
      "aircAruvnKk",
    );
  });

  it("extracts id from youtu.be path", () => {
    expect(extractVideoId("https://youtu.be/aircAruvnKk")).toBe("aircAruvnKk");
  });

  it("returns undefined for non-YouTube URLs", () => {
    expect(extractVideoId("https://example.com")).toBeUndefined();
  });
});

describe("parseTranscript", () => {
  it("parses [HH:MM:SS] text lines into segments with second timestamps", () => {
    const segments = parseTranscript(sampleTranscript);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ timestamp: 0, text: "[Music]" });
    expect(segments[1]).toEqual({ timestamp: 4, text: "Hello world" });
    expect(segments[2]).toEqual({ timestamp: 90, text: "Goodbye" });
  });

  it("returns empty array for empty input", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("\n\n")).toEqual([]);
  });

  it("skips lines without a timestamp prefix", () => {
    const raw = "[00:00:00] first\norphan line without timestamp\n[00:00:05] second";
    const segments = parseTranscript(raw);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("first");
    expect(segments[1].text).toBe("second");
  });
});

describe("buildTranscriptSections", () => {
  it("groups 15 segments into a deterministic number of sections", () => {
    const sections = buildTranscriptSections(makeSegments(15));
    expect(sections.length).toBe(2);
    for (const s of sections) {
      expect(s.section_type).toBe("transcript");
      expect(s.heading).toMatch(/^Transcript \d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}$/);
      expect(s.content_markdown).toBeTruthy();
      expect(s.content_text).toBeTruthy();
    }
    expect(sections[0].order).toBe(0);
    expect(sections[1].order).toBe(1);
    expect(sections[0].content_markdown).toContain("[00:00:00] line 0");
    expect(sections[0].content_text).toContain("line 0");
    expect(sections[0].content_text).not.toContain("[00:00:00]");
  });

  it("returns empty array for empty segments", () => {
    expect(buildTranscriptSections([])).toEqual([]);
  });
});

describe("YouTubePlugin.expand", () => {
  const metadata: YouTubeMetadata = {
    title: "Test Video",
    author_name: "Test Channel",
    author_url: "https://www.youtube.com/@test",
    thumbnail_url: "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg",
  };
  const transcript = "[00:00:00] Hello\n[00:00:05] World";

  it("returns a canonical ExpandResult using injected fetchers", async () => {
    const transcriptFetcher: TranscriptFetcher = vi.fn().mockResolvedValue(transcript);
    const metadataFetcher: MetadataFetcher = vi.fn().mockResolvedValue(metadata);
    const plugin = createYouTubePlugin({ transcriptFetcher, metadataFetcher });

    const result = await plugin.expand(ctx);

    expect(metadataFetcher).toHaveBeenCalledWith(ctx.url);
    expect(transcriptFetcher).toHaveBeenCalledWith(ctx.url);
    expect(result.title).toBe("Test Video");
    expect(result.sourceType).toBe("youtube");
    expect(result.authors).toEqual(["Test Channel"]);
    expect(result.publisher).toBe("YouTube");
    expect(result.canonicalUrl).toBe(ctx.url);
    expect(result.content).toBe(transcript);
    expect(result.plainText).toBe("Hello World");
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
    expect(result.sections[0].section_type).toBe("transcript");
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.videoId).toBe("aircAruvnKk");
    expect(result.metadata!.thumbnail_url).toBe(metadata.thumbnail_url);
    expect(result.metadata!.author_url).toBe(metadata.author_url);
  });

  it("throws when transcript is empty", async () => {
    const transcriptFetcher: TranscriptFetcher = vi.fn().mockResolvedValue("");
    const metadataFetcher: MetadataFetcher = vi.fn().mockResolvedValue(metadata);
    const plugin = createYouTubePlugin({ transcriptFetcher, metadataFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/no transcript available/);
  });

  it("throws when metadata fetch rejects", async () => {
    const transcriptFetcher: TranscriptFetcher = vi.fn().mockResolvedValue(transcript);
    const metadataFetcher: MetadataFetcher = vi
      .fn()
      .mockRejectedValue(new Error("oembed 503"));
    const plugin = createYouTubePlugin({ transcriptFetcher, metadataFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/oembed 503/);
  });
});
