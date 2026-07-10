/**
 * HTML email template for the PNIP digest.
 *
 * Per §45, "The HTML template is responsible only for presentation. Content
 * must originate exclusively from Markdown." So this module takes pre-rendered
 * HTML body content (produced by the Markdown renderer) and wraps it with
 * the email chrome: header, optional notebook/podcast links (§9 supplies
 * these from M9/M10 — until then the links are placeholders), sources
 * appendix, and a footer.
 *
 * The output is a complete, standalone HTML document with inline styles
 * suitable for email clients that strip <style> tags.
 */

export interface EmailTemplateInput {
  publicationDate: string;
  title: string;
  renderedHtmlBody: string;
  notebookUrl?: string | null;
  podcastUrl?: string | null;
  artifactLinks?: ArtifactLink[];
  editionId: string;
}

export interface ArtifactLink {
  kind: "notebook" | "podcast";
  partitionKey: string;
  label: string;
  url: string;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export function buildEmailTemplate(input: EmailTemplateInput): EmailTemplate {
  const subject = `Daily Digest — ${input.publicationDate}`;
  const notebookLink = input.notebookUrl ?? null;
  const podcastLink = input.podcastUrl ?? null;
  const artifacts: ArtifactLink[] = [...(input.artifactLinks ?? [])];
  if (notebookLink) {
    artifacts.push({ kind: "notebook", partitionKey: "master", label: "Discuss this Edition in NotebookLM", url: notebookLink });
  }
  if (podcastLink) {
    artifacts.push({ kind: "podcast", partitionKey: "master", label: "Listen to today's audio digest", url: podcastLink });
  }
  const uniqueArtifacts = artifacts.filter((artifact, index) =>
    artifacts.findIndex((candidate) => candidate.url === artifact.url) === index,
  );
  const supplementaryLinks = uniqueArtifacts.map((artifact) =>
    `<li><a href="${escapeAttr(artifact.url)}" rel="noopener noreferrer">${escapeHtml(artifact.label)}</a></li>`,
  );

  const supplementarySection =
    supplementaryLinks.length > 0
      ? `<section>
  <h2>Explore this edition</h2>
  <ul>
    ${supplementaryLinks.join("\n    ")}
  </ul>
</section>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-pnip-edition" content="${escapeAttr(input.editionId)}">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1f2933;line-height:1.55;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f5;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:12px 32px;border-bottom:1px solid #e5e7eb;background:#f8fafc;">
            <p style="margin:0;color:#475569;font-size:13px;">Daily Digest &middot; <strong>${escapeHtml(input.publicationDate)}</strong></p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px;">
${input.renderedHtmlBody}
${supplementarySection}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

  const text = [
    `${input.title}`,
    `Publication date: ${input.publicationDate}`,
    "",
    input.renderedHtmlBody
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+\n/g, "\n")
      .trim(),
    "",
    ...uniqueArtifacts.map((artifact) => `${artifact.label}: ${artifact.url}`),
  ]
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return { subject, html, text };
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
