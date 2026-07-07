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

  it("parses full Fabric output into title, canonicalUrl, publishedAt, and body", async () => {
    const raw =
      "Title: Test Article\n\n" +
      "URL Source: https://example.com/article\n\n" +
      "Published Time: Wed, 01 Jul 2026 12:00:00 GMT\n\n" +
      "Markdown Content:\n" +
      "# Test Article\n\n" +
      "This is the body text.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(fetchContent).toHaveBeenCalledWith("https://example.com/article");
    expect(result.title).toBe("Test Article");
    expect(result.canonicalUrl).toBe("https://example.com/article");
    expect(result.publishedAt).toBeInstanceOf(Date);
    expect(result.publishedAt!.toISOString()).toBe(
      new Date("Wed, 01 Jul 2026 12:00:00 GMT").toISOString(),
    );
    expect(result.content).toBe("# Test Article\n\nThis is the body text.");
    expect(result.sourceType).toBe("article");
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.sections[0].section_type).toBe("title");
    expect(result.sections[0].content_markdown).toBe("# Test Article");
    const para = result.sections.find((s) => s.section_type === "paragraph");
    expect(para).toBeDefined();
    expect(para!.content_text).toBe("This is the body text.");
  });

  it("returns undefined publishedAt when Fabric output omits Published Time", async () => {
    const raw =
      "Title: No Date\n\n" +
      "URL Source: https://example.com/nodate\n\n" +
      "Markdown Content:\n" +
      "Body without a date.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.publishedAt).toBeUndefined();
    expect(result.title).toBe("No Date");
    expect(result.canonicalUrl).toBe("https://example.com/nodate");
    expect(result.content).toBe("Body without a date.");
  });

  it("falls back to body heading when Fabric Title is empty", async () => {
    const raw =
      "Title: \n\n" +
      "URL Source: https://example.com/empty-title\n\n" +
      "Markdown Content:\n" +
      "# Body Heading\n\n" +
      "Some content.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("Body Heading");
    expect(result.content).toBe("# Body Heading\n\nSome content.");
  });

  it("falls back to URL when Title is empty and body has no heading", async () => {
    const raw =
      "Title: \n\n" +
      "URL Source: https://example.com/empty-title\n\n" +
      "Markdown Content:\n" +
      "Just plain text without any heading.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("https://example.com/article");
    expect(result.content).toBe("Just plain text without any heading.");
  });

  it("ignores Warning lines in Fabric output", async () => {
    const raw =
      "Title: Warned\n\n" +
      "URL Source: https://example.com/warned\n\n" +
      "Warning: This is a cached snapshot of the original page.\n\n" +
      "Markdown Content:\n" +
      "Body after warning.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("Warned");
    expect(result.canonicalUrl).toBe("https://example.com/warned");
    expect(result.content).toBe("Body after warning.");
    expect(result.content).not.toContain("Warning");
    expect(result.content).not.toContain("cached snapshot");
  });

  it("treats malformed output without Markdown Content marker as raw content with no metadata", async () => {
    const raw = "Just some text\nwithout any Fabric header markers at all.";
    const fetchContent = vi.fn().mockResolvedValue(raw);
    const plugin = createArticlePlugin({ fetchContent });

    const result = await plugin.expand(ctx);

    expect(result.content).toBe(raw);
    expect(result.canonicalUrl).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
    expect(result.title).toBe("https://example.com/article");
  });
});
