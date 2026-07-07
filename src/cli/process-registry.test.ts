import { describe, it, expect } from "vitest";
import { buildPluginRegistry } from "./process-registry.js";

describe("buildPluginRegistry", () => {
  it("registers all 5 plugins", () => {
    const registry = buildPluginRegistry();
    const names = new Set<string>();
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://www.reddit.com/r/foo/comments/abc/title",
      "https://example.com/episode.mp3",
      "https://example.com/doc.pdf",
      "https://example.com/article",
    ]) {
      const p = registry.select(url);
      expect(p).toBeDefined();
      names.add(p!.name);
    }
    expect(names.size).toBe(5);
    expect(names.has("youtube")).toBe(true);
    expect(names.has("reddit")).toBe(true);
    expect(names.has("podcast")).toBe(true);
    expect(names.has("pdf")).toBe(true);
    expect(names.has("article")).toBe(true);
  });

  it("selects the youtube plugin for youtube.com/watch", () => {
    const registry = buildPluginRegistry();
    expect(registry.select("https://www.youtube.com/watch?v=abc")?.name).toBe("youtube");
  });

  it("selects the reddit plugin for reddit comments urls", () => {
    const registry = buildPluginRegistry();
    expect(
      registry.select("https://www.reddit.com/r/foo/comments/abc/title")?.name,
    ).toBe("reddit");
  });

  it("selects the podcast plugin for audio extensions", () => {
    const registry = buildPluginRegistry();
    expect(registry.select("https://example.com/episode.mp3")?.name).toBe("podcast");
  });

  it("selects the pdf plugin for .pdf urls", () => {
    const registry = buildPluginRegistry();
    expect(registry.select("https://example.com/doc.pdf")?.name).toBe("pdf");
  });

  it("falls back to the article plugin for generic http urls", () => {
    const registry = buildPluginRegistry();
    expect(registry.select("https://example.com/article")?.name).toBe("article");
  });

  it("registers specific plugins before the article fallback", () => {
    const registry = buildPluginRegistry();
    const youtube = registry.select("https://www.youtube.com/watch?v=abc");
    expect(youtube?.name).toBe("youtube");
    expect(youtube?.name).not.toBe("article");
  });
});
