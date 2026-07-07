/**
 * Minimal, deterministic Markdown → HTML renderer for the PNIP digest.
 *
 * Scope: §45 ("Markdown is transformed into HTML. … The HTML template is
 * responsible only for presentation. Content must originate exclusively from
 * Markdown."). The renderer is intentionally limited to the subset that the
 * Markdown Digest Service emits (§43):
 *
 *   - ATX headings: `#`, `##`, `###` (h1 / h2 / h3)
 *   - paragraphs (any non-empty line not recognised as another block)
 *   - unordered lists (`- `, `* `) → `<ul><li>`
 *   - inline `**bold**` → `<strong>`
 *   - inline `_italic_` → `<em>`
 *   - inline `[text](url)` → `<a href="url" rel="noopener noreferrer">text</a>`
 *   - inline `[N]` citation tokens are left intact verbatim (they reference
 *     the Sources block and are not semantic anchors; styling is the
 *     template's job).
 *
 * Anything else (blockquotes, code fences, tables, etc.) is not emitted by
 * the Markdown Digest Service, so we ignore it deliberately — the renderer is
 * not a generic Markdown parser, it is the §45 projection.
 */

export interface MarkdownRenderOptions {
  /**
   * URL sanitizer applied to inline `[text](url)` references. Defaults to
   * `safeHref` (only http/https/mailto). Override only for tests.
   */
  sanitizeHref?: (raw: string) => string | null;
}

export function renderHtml(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string {
  const sanitize = options.sanitizeHref ?? safeHref;
  const lines = normalizeNewlines(markdown).split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // ATX heading: `#`, `##`, `###` (we never emit deeper levels).
    const heading = /^(\#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = applyInline(heading[2]!, sanitize);
      out.push(`<h${level}>${text}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list: lines starting with `- ` or `* `.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^[-*]\s+/, "");
        items.push(`<li>${applyInline(item, sanitize)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Paragraph: collect consecutive non-empty non-block lines.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(\#{1,3})\s+/.test(lines[i]!) &&
      !/^[-*]\s+/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    if (paragraph.length > 0) {
      const joined = paragraph.join(" ");
      out.push(`<p>${applyInline(joined, sanitize)}</p>`);
    }
  }

  return out.join("\n").trim() + "\n";
}

/**
 * Plain-text fallback for email readers that refuse HTML. Strips markdown
 * syntax that is purely presentation: heading markers, list bullets, link
 * URLs (preserving the link text), bold/italic delimiters. Leaves citation
 * `[N]` tokens and inline code intact.
 */
export function renderPlainText(markdown: string): string {
  const lines = normalizeNewlines(markdown).split("\n");
  const out: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine.replace(/\r/g, "");

    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // Headings: drop the leading `#`/`##`/`###` and surrounding whitespace.
    line = line.replace(/^(\#{1,6})\s+/, "");
    // Unordered list bullets: drop leading `- ` / `* `.
    if (/^[-*]\s+/.test(line)) {
      line = line.replace(/^[-*]\s+/, "");
    }
    line = applyPlainInline(line);
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function applyInline(input: string, sanitize: (raw: string) => string | null): string {
  let s = input;
  // Escape HTML first so user-content can never inject markup.
  s = escapeHtml(s);

  // Inline links: [text](url). The inner "text" has already been HTML-escaped
  // so it is safe to embed between <a> tags as-is.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_full, text: string, url: string) => {
    const safe = sanitize(url);
    if (safe === null) return text;
    return `<a href="${escapeAttr(safe)}" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold: **text** → <strong>text</strong>.
  s = s.replace(/\*\*([^*]+)\*\*/g, (_full, t: string) => `<strong>${t}</strong>`);
  // Italic: _text_ → <em>text</em>. Only single-underscore (the digest
  // never emits double-underscores which would ambiguous with __bold__).
  s = s.replace(/(^|[^\\])_([^_\n]+)_/g, (_full, lead: string, t: string) => `${lead}<em>${t}</em>`);

  return s;
}

function applyPlainInline(input: string): string {
  let s = input;
  // Inline links → "text (url)".
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_full, text: string, url: string) => {
    if (text.trim() === url.trim()) return text;
    return `${text} (${url})`;
  });
  // Drop bold/italic delimiters but keep the inner text.
  s = s.replace(/\*\*([^*]+)\*\*/g, (_full, t: string) => t);
  s = s.replace(/(^|[^\\])_([^_\n]+)_/g, (_full, lead: string, t: string) => `${lead}${t}`);
  return s;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

export function safeHref(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  if (SAFE_PROTOCOLS.test(trimmed)) return trimmed;
  return null;
}
