import { describe, it, expect, vi } from "vitest";
import {
  createPdfPlugin,
  deriveTitleFromUrl,
  extractTitleFromMarkdown,
  type PdfDownloader,
  type MarkdownFetcher,
} from "./pdf-plugin.js";
import type { ExpandContext } from "./types.js";

const ctx: ExpandContext = {
  url: "https://example.com/docs/report-2024.pdf",
  editionId: "e1",
  discoveryEventId: "d1",
};

describe("PdfPlugin.supports", () => {
  const plugin = createPdfPlugin();

  it("matches .pdf URLs", () => {
    expect(plugin.supports("https://example.com/doc.pdf")).toBe(true);
  });

  it("matches .PDF case-insensitively", () => {
    expect(plugin.supports("https://example.com/doc.PDF")).toBe(true);
  });

  it("matches URLs with query strings", () => {
    expect(plugin.supports("https://example.com/doc.pdf?token=abc")).toBe(true);
  });

  it("rejects .html pages", () => {
    expect(plugin.supports("https://example.com/page.html")).toBe(false);
  });

  it("rejects .mp3 episodes", () => {
    expect(plugin.supports("https://example.com/episode.mp3")).toBe(false);
  });
});

describe("deriveTitleFromUrl", () => {
  it("title-cases the last path segment with hyphens", () => {
    expect(
      deriveTitleFromUrl("https://example.com/docs/report-2024.pdf"),
    ).toBe("Report 2024");
  });

  it("title-cases a single-segment name", () => {
    expect(deriveTitleFromUrl("https://example.com/whitepaper.pdf")).toBe(
      "Whitepaper",
    );
  });
});

describe("extractTitleFromMarkdown", () => {
  it("extracts H1 title and returns the rest as body", () => {
    const { title, body } = extractTitleFromMarkdown("# My Document\n\nBody text");
    expect(title).toBe("My Document");
    expect(body).toBe("Body text");
  });

  it("returns undefined title when no H1 is present", () => {
    const { title, body } = extractTitleFromMarkdown("Just text, no heading");
    expect(title).toBeUndefined();
    expect(body).toBe("Just text, no heading");
  });
});

describe("PdfPlugin.expand", () => {
  it("returns a canonical ExpandResult using injected fakes", async () => {
    const pdfDownloader: PdfDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.pdf");
    const markdownFetcher: MarkdownFetcher = vi
      .fn()
      .mockResolvedValue("# Test PDF\n\nThis is the content.");
    const plugin = createPdfPlugin({ pdfDownloader, markdownFetcher });

    const result = await plugin.expand(ctx);

    expect(pdfDownloader).toHaveBeenCalledWith(ctx.url);
    expect(markdownFetcher).toHaveBeenCalledWith("/tmp/fake.pdf");
    expect(result.title).toBe("Test PDF");
    expect(result.sourceType).toBe("pdf");
    expect(result.canonicalUrl).toBe(ctx.url);
    expect(result.content).toBe("This is the content.");
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("derives title from URL when no H1 is present", async () => {
    const pdfDownloader: PdfDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.pdf");
    const markdownFetcher: MarkdownFetcher = vi
      .fn()
      .mockResolvedValue("Just plain text.");
    const plugin = createPdfPlugin({ pdfDownloader, markdownFetcher });

    const result = await plugin.expand(ctx);

    expect(result.title).toBe("Report 2024");
    expect(result.content).toBe("Just plain text.");
  });

  it("throws when markitdown output is empty", async () => {
    const pdfDownloader: PdfDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.pdf");
    const markdownFetcher: MarkdownFetcher = vi.fn().mockResolvedValue("");
    const plugin = createPdfPlugin({ pdfDownloader, markdownFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/PDF extraction failed/);
  });

  it("throws when markdown fetcher rejects", async () => {
    const pdfDownloader: PdfDownloader = vi
      .fn()
      .mockResolvedValue("/tmp/fake.pdf");
    const markdownFetcher: MarkdownFetcher = vi
      .fn()
      .mockRejectedValue(new Error("markitdown exited 1"));
    const plugin = createPdfPlugin({ pdfDownloader, markdownFetcher });

    await expect(plugin.expand(ctx)).rejects.toThrow(/markitdown exited 1/);
  });
});
