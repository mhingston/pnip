import { createHash } from "node:crypto";

export interface ChunkInput {
  id: string;
  documentId: string;
  sectionId: string;
  sequence: number;
  text: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  paragraphStart: number;
  paragraphEnd: number;
  timestampStart?: number;
  timestampEnd?: number;
}

export interface ChunkableSection {
  id: string;
  document_id: string;
  content_text: string | null;
  metadata: unknown;
}

const TARGET_TOKEN_COUNT = 1000;
// Most web articles fit comfortably in a single model request.  Keep the
// chunk representation for genuinely long material and timed transcripts,
// where splitting remains necessary for coverage and citations.
const DOCUMENT_CHUNKING_THRESHOLD = TARGET_TOKEN_COUNT * 2;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function deterministicChunkId(documentId: string, sectionId: string, sequence: number): string {
  const hash = createHash("sha256")
    .update(`${documentId}:${sectionId}:${sequence}`)
    .digest("hex");
  return hash.slice(0, 32);
}

function parseSectionMetadata(metadata: unknown): { timestampStart?: number; timestampEnd?: number } {
  if (!metadata || typeof metadata !== "object") return {};
  const m = metadata as Record<string, unknown>;
  const tsStart = typeof m.timestamp_start === "number" ? m.timestamp_start : undefined;
  const tsEnd = typeof m.timestamp_end === "number" ? m.timestamp_end : undefined;
  return { timestampStart: tsStart, timestampEnd: tsEnd };
}

function splitLongParagraph(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const parts: string[] = [];
  let current = "";
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > TARGET_TOKEN_COUNT) {
      if (current) {
        parts.push(current);
        current = "";
        currentTokens = 0;
      }
      const words = sentence.split(/\s+/);
      let group = "";
      let groupTokens = 0;
      for (const word of words) {
        const wordTokens = estimateTokens(word + " ");
        if (groupTokens + wordTokens > TARGET_TOKEN_COUNT && group) {
          parts.push(group);
          group = word + " ";
          groupTokens = wordTokens;
        } else {
          group += word + " ";
          groupTokens += wordTokens;
        }
      }
      if (group) parts.push(group);
    } else if (currentTokens + sentenceTokens > TARGET_TOKEN_COUNT && current) {
      parts.push(current);
      current = sentence;
      currentTokens = sentenceTokens;
    } else {
      current += sentence;
      currentTokens += sentenceTokens;
    }
  }

  if (current) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function chunkSection(section: ChunkableSection, globalSequenceStart: number): ChunkInput[] {
  const text = section.content_text ?? "";
  if (!text) return [];

  const { timestampStart, timestampEnd } = parseSectionMetadata(section.metadata);
  const paragraphs = text.split(/\n\n+/);
  const chunks: ChunkInput[] = [];
  let currentParagraphs: string[] = [];
  let runningTokens = 0;
  let chunkParagraphStart = 0;

  function flush(): void {
    if (currentParagraphs.length === 0) return;
    const chunkText = currentParagraphs.join("\n\n");
    const startOffset = 0;
    const endOffset = chunkText.length;
    chunks.push({
      id: deterministicChunkId(section.document_id, section.id, globalSequenceStart + chunks.length),
      documentId: section.document_id,
      sectionId: section.id,
      sequence: globalSequenceStart + chunks.length,
      text: chunkText,
      tokenCount: runningTokens,
      startOffset,
      endOffset,
      paragraphStart: chunkParagraphStart,
      paragraphEnd: chunkParagraphStart + currentParagraphs.length - 1,
      timestampStart,
      timestampEnd,
    });
    currentParagraphs = [];
    runningTokens = 0;
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraTokens = estimateTokens(para);

    if (paraTokens > TARGET_TOKEN_COUNT) {
      flush();
      const subParagraphs = splitLongParagraph(para);
      for (const sub of subParagraphs) {
        const subTokens = estimateTokens(sub);
        chunks.push({
          id: deterministicChunkId(section.document_id, section.id, globalSequenceStart + chunks.length),
          documentId: section.document_id,
          sectionId: section.id,
          sequence: globalSequenceStart + chunks.length,
          text: sub,
          tokenCount: subTokens,
          startOffset: 0,
          endOffset: sub.length,
          paragraphStart: i,
          paragraphEnd: i,
          timestampStart,
          timestampEnd,
        });
      }
      chunkParagraphStart = i + 1;
      continue;
    }

    const wouldExceed = runningTokens + paraTokens > TARGET_TOKEN_COUNT && currentParagraphs.length > 0;

    if (wouldExceed) {
      flush();
      chunkParagraphStart = i;
    }

    currentParagraphs.push(para);
    runningTokens += paraTokens;
  }

  flush();

  return chunks;
}

export function chunkAllSections(sections: ChunkableSection[]): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  let sequence = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(section, sequence);
    chunks.push(...sectionChunks);
    sequence += sectionChunks.length;
  }

  return chunks;
}

function isTimedSection(section: ChunkableSection): boolean {
  const { timestampStart, timestampEnd } = parseSectionMetadata(section.metadata);
  return timestampStart !== undefined || timestampEnd !== undefined;
}

/**
 * Make the default unit of enrichment a whole article.  A document-level
 * chunk is still stored in document_chunks so all existing provenance and
 * citation consumers continue to work unchanged.  Long/timed content falls
 * back to the established section chunker.
 */
export function chunkDocumentSections(sections: ChunkableSection[]): ChunkInput[] {
  const nonEmpty = sections.filter((section) => Boolean(section.content_text?.trim()));
  if (nonEmpty.length === 0) return [];

  const text = nonEmpty.map((section) => section.content_text!.trim()).join("\n\n");
  if (
    estimateTokens(text) > DOCUMENT_CHUNKING_THRESHOLD ||
    nonEmpty.some(isTimedSection)
  ) {
    return chunkAllSections(nonEmpty);
  }

  const first = nonEmpty[0];
  const last = nonEmpty[nonEmpty.length - 1];
  return [{
    id: deterministicChunkId(first.document_id, first.id, 0),
    documentId: first.document_id,
    sectionId: first.id,
    sequence: 0,
    text,
    tokenCount: estimateTokens(text),
    startOffset: 0,
    endOffset: text.length,
    paragraphStart: 0,
    paragraphEnd: Math.max(0, (last.content_text?.split(/\n\n+/).length ?? 1) - 1),
  }];
}
