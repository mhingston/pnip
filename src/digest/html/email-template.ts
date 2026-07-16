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
    `<li><a class="email-artifact-link" href="${escapeAttr(artifact.url)}" rel="noopener noreferrer" style="display:block;padding:12px 14px;border:1px solid #cbd5e1;border-radius:6px;color:#1d4ed8;font-weight:600;line-height:1.35;text-decoration:none;">${escapeHtml(artifact.label)}</a></li>`,
  );

  const supplementarySection =
    supplementaryLinks.length > 0
      ? `<section class="email-supplementary">
  <h2>Explore this edition</h2>
  <ul class="email-artifact-list">
    ${supplementaryLinks.join("\n    ")}
  </ul>
</section>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="x-pnip-edition" content="${escapeAttr(input.editionId)}">
<title>${escapeHtml(input.title)}</title>
<style>
  html, body {
    width: 100% !important;
    min-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  body, table, td, p, h1, h2, h3, li, a {
    -webkit-text-size-adjust: 100%;
    -ms-text-size-adjust: 100%;
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    border: 0;
  }
  .email-page-cell {
    padding: 24px 12px !important;
  }
  .email-shell {
    width: 100% !important;
    max-width: 600px !important;
  }
  .email-content {
    font-size: 16px !important;
    line-height: 1.6 !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .email-content h1,
  .email-content h2,
  .email-content h3 {
    color: #0f172a;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .email-content h1 {
    margin: 0 0 20px;
    font-size: 32px;
    line-height: 1.2;
  }
  .email-content h2 {
    margin: 32px 0 12px;
    padding-top: 20px;
    border-top: 1px solid #e5e7eb;
    font-size: 24px;
    line-height: 1.25;
  }
  .email-content h3 {
    margin: 28px 0 10px;
    font-size: 19px;
    line-height: 1.35;
  }
  .email-content p {
    margin: 0 0 18px;
  }
  .email-content ul {
    margin: 0 0 20px;
    padding-left: 22px;
  }
  .email-content li {
    margin: 0 0 10px;
    padding-left: 2px;
  }
  .email-content a {
    color: #1d4ed8;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .email-supplementary {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid #e5e7eb;
  }
  .email-supplementary h2 {
    margin: 0 0 14px;
    color: #0f172a;
    font-size: 22px;
    line-height: 1.25;
  }
  .email-artifact-list {
    margin: 0 !important;
    padding: 0 !important;
    list-style: none;
  }
  .email-artifact-list li {
    margin: 0 0 10px;
  }
  .email-artifact-link {
    display: block;
    padding: 12px 14px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    color: #1d4ed8;
    font-weight: 600;
    line-height: 1.35;
    text-decoration: none;
  }
  @media only screen and (max-width: 600px) {
    .email-page-cell {
      padding: 12px 0 !important;
    }
    .email-shell {
      border-right: 0 !important;
      border-left: 0 !important;
      border-radius: 0 !important;
    }
    .email-header,
    .email-content {
      padding-right: 20px !important;
      padding-left: 20px !important;
    }
    .email-content h1 {
      font-size: 28px !important;
    }
    .email-content h2 {
      margin-top: 28px !important;
      padding-top: 18px !important;
      font-size: 22px !important;
    }
    .email-content h3 {
      margin-top: 24px !important;
      font-size: 18px !important;
    }
  }
  @media only screen and (max-width: 380px) {
    .email-header,
    .email-content {
      padding-right: 16px !important;
      padding-left: 16px !important;
    }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1f2933;line-height:1.6;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#f4f4f5;">
  <tr>
    <td class="email-page-cell" align="center" style="padding:24px 12px;">
      <table role="presentation" class="email-shell" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td class="email-header" style="padding:12px 32px;border-bottom:1px solid #e5e7eb;background:#f8fafc;">
            <p style="margin:0;color:#475569;font-size:13px;">Daily Digest &middot; <strong>${escapeHtml(input.publicationDate)}</strong></p>
          </td>
        </tr>
        <tr>
          <td class="email-content" style="padding:28px 32px 32px;font-size:16px;line-height:1.6;color:#1f2933;overflow-wrap:anywhere;word-break:break-word;">
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
