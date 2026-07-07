import { describe, it, expect, vi } from "vitest";
import { createArticlePlugin } from "./article-plugin.js";
import type { ExpandContext } from "./types.js";

describe("ArticlePlugin", () => {
  const ctx: ExpandContext = {
    url: "https://example.com/article",
    editionId: "e1",
    discoveryEventId: "d1",
  };

  it("supports http and https URLs", () => {
    const plugin = createArticlePlugin({ fetchContent: vi.fn() });
    expect(plugin.supports("https://example.com/article")).toBe(true);
    expect(plugin.supports("http://example.com/article")).toBe(true);
  });

  it("does not support non-http URLs or known platform URLs", () => {
    const plugin = createArticlePlugin({ fetchContent: vi.fn() });
    expect(plugin.supports("ftp://example.com/file")).toBe(false);
    expect(plugin.supports("https://youtube.com/watch?v=abc")).toBe(false);
    expect(plugin.supports("https://reddit.com/r/test")).toBe(false);
    expect(plugin.supports("https://youtu.be/abc123")).toBe(false);
  });

  it("supports general http and https URLs", () => {
    const plugin = createArticlePlugin({ fetchContent: vi.fn() });
    expect(plugin.supports("https://example.com/article")).toBe(true);
    expect(plugin.supports("http://blog.example.com/post")).toBe(true);
  });

  it("returns article expand result from fetched markdown", async () => {
    const fetchContent = vi.fn().mockResolvedValue("# Hello\n\nThis is the body.");
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("Hello");
    expect(result.content).toBe("# Hello\n\nThis is the body.");
    expect(result.sourceType).toBe("article");
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].section_type).toBe("title");
    expect(result.sections[0].content_markdown).toBe("# Hello");
    expect(result.sections[1].section_type).toBe("paragraph");
  });

  it("handles URL as title when no h1 in content", async () => {
    const fetchContent = vi.fn().mockResolvedValue("Just plain text without headers.");
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("https://example.com/article");
    expect(result.content).toBe("Just plain text without headers.");
  });
});
