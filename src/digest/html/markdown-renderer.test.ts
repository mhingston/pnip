import { describe, it, expect } from "vitest";
import {
  renderHtml,
  renderPlainText,
  safeHref,
} from "./markdown-renderer.js";

describe("renderHtml — block elements", () => {
  it("renders h1 from '# Title'", () => {
    expect(renderHtml("# Title").trim()).toBe("<h1>Title</h1>");
  });

  it("renders h2 from '## Title'", () => {
    expect(renderHtml("## Title").trim()).toBe("<h2>Title</h2>");
  });

  it("renders h3 from '### Title'", () => {
    expect(renderHtml("### Title").trim()).toBe("<h3>Title</h3>");
  });

  it("does not render h4 or deeper (the digest only emits up to h3)", () => {
    const out = renderHtml("#### Title");
    expect(out).not.toContain("<h4>");
    expect(out).toContain("#### Title");
  });

  it("renders a paragraph", () => {
    expect(renderHtml("Hello world.").trim()).toBe(
      "<p>Hello world.</p>",
    );
  });

  it("collapses multi-line paragraphs into one <p>", () => {
    expect(
      renderHtml("First line.\nSecond line on next.").trim(),
    ).toBe("<p>First line. Second line on next.</p>");
  });

  it("renders unordered lists with '- ' bullets", () => {
    const md = "- first\n- second\n- third";
    const out = renderHtml(md);
    expect(out.trim()).toBe(
      "<ul><li>first</li><li>second</li><li>third</li></ul>",
    );
  });

  it("renders unordered lists with '* ' bullets", () => {
    const md = "* alpha\n* beta";
    const out = renderHtml(md);
    expect(out.trim()).toBe(
      "<ul><li>alpha</li><li>beta</li></ul>",
    );
  });

  it("renders a heading immediately followed by a paragraph", () => {
    const out = renderHtml("## Section\nBody text.");
    expect(out).toContain("<h2>Section</h2>");
    expect(out).toContain("<p>Body text.</p>");
  });

  it("normalizes CRLF / CR line endings", () => {
    expect(renderHtml("## A\r\n\r\n## B").trim()).toBe(
      "<h2>A</h2>\n<h2>B</h2>",
    );
  });
});

describe("renderHtml — inline elements", () => {
  it("renders an inline link with rel=noopener noreferrer", () => {
    const out = renderHtml("[Example](https://example.com)").trim();
    expect(out).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">Example</a></p>',
    );
  });

  it("preserves citation tokens verbatim inside paragraphs", () => {
    const out = renderHtml("A claim is supported here. [1]").trim();
    expect(out).toBe("<p>A claim is supported here. [1]</p>");
  });

  it("renders bold **text** as <strong>", () => {
    const out = renderHtml("This is **bold** text.").trim();
    expect(out).toBe("<p>This is <strong>bold</strong> text.</p>");
  });

  it("renders italic _text_ as <em>", () => {
    const out = renderHtml("This is _italic_ text.").trim();
    expect(out).toBe("<p>This is <em>italic</em> text.</p>");
  });

  it("mixes bold + italic + link within the same paragraph", () => {
    const out = renderHtml("**Bold** and _italic_ with [a link](https://e.co).").trim();
    expect(out).toBe(
      '<p><strong>Bold</strong> and <em>italic</em> with <a href="https://e.co" rel="noopener noreferrer">a link</a>.</p>',
    );
  });

  it("escapes HTML metacharacters in body text", () => {
    const out = renderHtml("Some <script>alert(1)</script> text.");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("rejects javascript: URLs", () => {
    const out = renderHtml("[evil](javascript:alert(1))");
    expect(out).not.toContain("href=");
    expect(out).toContain("evil");
  });

  it("strips plain http schemes that look unsafe (e.g., ftp)", () => {
    const out = renderHtml("[bad](ftp://files.example.com/a)");
    expect(out).not.toContain('href="ftp://');
  });

  it("allows http and mailto", () => {
    const out = renderHtml("[mail](mailto:a@b.co) and [http](http://x.co)");
    expect(out).toContain('href="mailto:a@b.co"');
    expect(out).toContain('href="http://x.co"');
  });
});

describe("safeHref", () => {
  it("passes through https / http / mailto", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  it("passes through relative paths and fragments", () => {
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("/foo/bar")).toBe("/foo/bar");
  });

  it("rejects javascript: and other protocols", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});

describe("renderPlainText", () => {
  it("strips heading markers but keeps the title", () => {
    expect(renderPlainText("# Title").trim()).toBe("Title");
    expect(renderPlainText("## Section").trim()).toBe("Section");
    expect(renderPlainText("### Subsection").trim()).toBe("Subsection");
  });

  it("strips list bullets", () => {
    expect(renderPlainText("- one\n- two").trim()).toBe("one\ntwo");
  });

  it("expands [text](url) to 'text (url)' when text differs from url", () => {
    expect(renderPlainText("[Read more](https://example.com/x)").trim()).toBe(
      "Read more (https://example.com/x)",
    );
  });

  it("keeps only the link text when text and url collide", () => {
    expect(
      renderPlainText("[https://example.com](https://example.com)").trim(),
    ).toBe("https://example.com");
  });

  it("strips ** and _ delimiters", () => {
    expect(renderPlainText("**bold** and _italic_").trim()).toBe(
      "bold and italic",
    );
  });

  it("leaves citation [N] tokens alone", () => {
    expect(renderPlainText("A claim. [1]").trim()).toBe("A claim. [1]");
  });

  it("normalizes excessive blank lines", () => {
    const md = "first\n\n\n\n\nsecond";
    const out = renderPlainText(md);
    expect(out).not.toContain("\n\n\n");
  });
});
