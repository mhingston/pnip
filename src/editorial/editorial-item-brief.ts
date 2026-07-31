import type { DocumentChunkRow } from "../chunking/chunk-repository.js";
import type { DocumentRow } from "../expansion/document-repository.js";
import type { SummaryRow } from "../enrichment/summary/summary-repository.js";
import { deriveSourceIdentity } from "../signals/source-identity.js";

export interface EditorialItemBrief {
  documentId: string;
  title: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  sourceType: string;
  publisher: string | null;
  authors: string[];
  publishedAt: string | null;
  summary: string;
  evidence: Array<{ chunkId: string; text: string }>;
  sourceIdentity: string | null;
  sourceTrustTier: number | null;
  sourcePriorityBoost: number;
}

const MAX_SUMMARY_CHARS = 900;
const MAX_EVIDENCE_CHARS = 360;
const MAX_EVIDENCE = 4;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseAuthors(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  }
  return [];
}

export function buildEditorialItemBrief(input: {
  document: DocumentRow;
  summaries: SummaryRow[];
  chunks: DocumentChunkRow[];
  sourceTrustTier?: number | null;
  sourcePriorityBoost?: number;
}): EditorialItemBrief {
  const { document } = input;
  const summaries = input.summaries.map((s) => s.content.trim()).filter(Boolean);
  const chunks = [...input.chunks].sort((a, b) => a.chunk_sequence - b.chunk_sequence);
  const step = Math.max(1, Math.ceil(chunks.length / MAX_EVIDENCE));
  const evidence = chunks.filter((_, index) => index % step === 0).slice(0, MAX_EVIDENCE)
    .map((chunk) => ({ chunkId: chunk.id, text: clip(chunk.content_text.trim(), MAX_EVIDENCE_CHARS) }));
  return {
    documentId: document.id,
    title: (document.title ?? document.source_url).trim() || document.source_url,
    sourceUrl: document.source_url,
    canonicalUrl: document.canonical_url,
    sourceType: document.source_type,
    publisher: document.publisher,
    authors: parseAuthors(document.authors),
    publishedAt: document.published_at?.toISOString() ?? null,
    summary: clip(summaries.join(" ") || document.content_text?.trim() || "", MAX_SUMMARY_CHARS),
    evidence,
    sourceIdentity: deriveSourceIdentity({ sourceUrl: document.source_url, sourceType: document.source_type, publisher: document.publisher, metadata: document.metadata }),
    sourceTrustTier: input.sourceTrustTier ?? null,
    sourcePriorityBoost: input.sourcePriorityBoost ?? 0,
  };
}

export function sortEditorialBriefs(briefs: EditorialItemBrief[]): EditorialItemBrief[] {
  return [...briefs].sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || a.documentId.localeCompare(b.documentId));
}
