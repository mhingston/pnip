import { describe, it, expect, vi } from "vitest";
import {
  createPodcastPlugin,
  deriveTitleFromUrl,
  parseFilenameFromContentDisposition,
  buildTranscriptSections,
  type AudioDownloader,
  type TranscribeFetcher,
} from "./podcast-plugin.js";
import type { ExpandContext } from "./types.js";

const ctx: ExpandContext = {
  url: "https://example.com/episodes/welcome-to-the-show-ep-1.mp3",
  editionId: "e1",
  discoveryEventId: "d1",
};

describe("PodcastPlugin.supports", () => {
  const plugin = createPodcastPlugin();

  it("matches .mp3 URLs", () => {
    expect(plugin.supports("https://example.com/episode.mp3")).toBe(true);
  });

  it("matches .M4A case-insensitively", () => {
    expect(plugin.supports("https://example.com/episode.M4A")).toBe(true);
  });

  it("matches URLs with query strings", () => {
    expect(plugin.supports("https://example.com/episode.mp3?token=abc")).toBe(true);
  });

  it("matches .wav URLs", () => {
    expect(plugin.supports("https://example.com/episode.wav")).toBe(true);
  });

  it("matches other audio extensions", () => {
    expect(plugin.supports("https://example.com/ep.aac")).toBe(true);
    expect(plugin.supports("https://example.com/ep.ogg")).toBe(true);
    expect(plugin.supports("https://example.com/ep.oga")).toBe(true);
    expect(plugin.supports("https://example.com/ep.opus")).toBe(true);
  });

  it("rejects .html pages", () => {
    expect(plugin.supports("https://example.com/page.html")).toBe(false);
  });

  it("rejects YouTube watch URLs", () => {
    expect(plugin.supports("https://www.youtube.com/watch?v=abc")).toBe(false);
  });
});

describe("deriveTitleFromUrl", () => {
  it("title-cases the last path segment with hyphens", () => {
    expect(
      deriveTitleFromUrl("https://example.com/episodes/my-podcast-ep-42.mp3"),
    ).toBe("My Podcast Ep 42");
  });

  it("title-cases the last path segment with underscores", () => {
    expect(deriveTitleFromUrl("https://cdn.example.com/audio/tech_talk.aac")).toBe(
      "Tech Talk",
    );
  });

  it("falls back to Audio when no path segment", () => {
    expect(deriveTitleFromUrl("https://example.com/")).toBe("Audio");
  });
});

describe("parseFilenameFromContentDisposition", () => {
  it("parses filename from attachment header", () => {
    expect(
      parseFilenameFromContentDisposition('attachment; filename="episode42.mp3"'),
    ).toBe("episode42.mp3");
  });

  it("returns undefined for null", () => {
    expect(parseFilenameFromContentDisposition(null)).toBeUndefined();
  });

  it("returns undefined for inline without filename", () => {
    expect(parseFilenameFromContentDisposition("inline")).toBeUndefined();
  });
});

describe("buildTranscriptSections", () => {
  it("splits multi-paragraph input into ordered transcript sections", () => {
    const sections = buildTranscriptSections("Para 1\n\nPara 2\n\nPara 3");
    expect(sections).toHaveLength(3);
    expect(sections[0].section_type).toBe("transcript");
    expect(sections[1].section_type).toBe("transcript");
    expect(sections[2].section_type).toBe("transcript");
    expect(sections[0].heading).toBe("Transcript part 1");
    expect(sections[1].heading).toBe("Transcript part 2");
    expect(sections[2].heading).toBe("Transcript part 3");
    expect(sections[0].content_markdown).toBe("Para 1");
    expect(sections[0].content_text).toBe("Para 1");
  });

  it("returns a single section for a single block", () => {
    const sections = buildTranscriptSections("Just one paragraph of text");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Transcript part 1");
    expect(sections[0].section_type).toBe("transcript");
  });

  it("returns empty array for empty input", () => {
    expect(buildTranscriptSections("")).toEqual([]);
    expect(buildTranscriptSections("   \n\n  ")).toEqual([]);
  });
});

describe("PodcastPlugin.expand", () => {
  it("returns a canonical ExpandResult using injected fakes", async () => {
    const audioDownloader: AudioDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.mp3");
    const transcript = "Welcome to the show.\n\nToday we talk about tech.";
    const transcribeFetcher: TranscribeFetcher = vi
      .fn()
      .mockResolvedValue(transcript);
    const plugin = createPodcastPlugin({ audioDownloader, transcribeFetcher });

    const result = await plugin.expand(ctx);

    expect(audioDownloader).toHaveBeenCalledWith(ctx.url);
    expect(transcribeFetcher).toHaveBeenCalledWith("/tmp/fake.mp3");
    expect(result.title).toBe("Welcome To The Show Ep 1");
    expect(result.sourceType).toBe("podcast");
    expect(result.canonicalUrl).toBe(ctx.url);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].section_type).toBe("transcript");
    expect(result.content).toBe(transcript);
    expect(result.plainText).toBe(transcript);
    expect(result.metadata).toEqual({ sourceUrl: ctx.url });
  });

  it("throws when transcript is empty", async () => {
    const audioDownloader: AudioDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.mp3");
    const transcribeFetcher: TranscribeFetcher = vi.fn().mockResolvedValue("");
    const plugin = createPodcastPlugin({ audioDownloader, transcribeFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/transcription failed/);
  });

  it("throws when transcribe fetcher rejects", async () => {
    const audioDownloader: AudioDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.mp3");
    const transcribeFetcher: TranscribeFetcher = vi
      .fn()
      .mockRejectedValue(new Error("fabric exited 1"));
    const plugin = createPodcastPlugin({ audioDownloader, transcribeFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/fabric exited 1/);
  });
});
