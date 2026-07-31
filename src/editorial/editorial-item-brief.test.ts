import { describe, expect, it } from "vitest";
import { buildEditorialItemBrief, sortEditorialBriefs } from "./editorial-item-brief.js";

describe("editorial item briefs", () => {
  it("clips summaries and samples evidence deterministically", () => {
    const brief = buildEditorialItemBrief({
      document: { id: "b", edition_id: "e", source_type: "youtube", source_url: "https://example.test/v", canonical_url: null, title: "Video", subtitle: null, authors: [], publisher: null, published_at: new Date("2026-01-01"), language: "en", content_markdown: null, content_text: null, metadata: null, created_at: new Date(), partition_key: "master" },
      summaries: [{ id: "s", chunk_id: "c", document_id: "b", content: "x".repeat(1000), prompt_id: "p", prompt_version: 1, model: "m", provider: "p", input_hash: "h", created_at: new Date() }],
      chunks: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, document_id: "b", section_id: "s", chunk_sequence: i, content_text: `chunk ${i}`, token_count: 1, start_offset: 0, end_offset: 1, paragraph_start: 0, paragraph_end: 0, timestamp_start: null, timestamp_end: null, created_at: new Date() })),
    });
    expect(brief.summary.length).toBe(900);
    expect(brief.evidence.map((e) => e.chunkId)).toEqual(["c0", "c2", "c4", "c6"]);
    expect(sortEditorialBriefs([brief]).map((x) => x.documentId)).toEqual(["b"]);
  });
});
