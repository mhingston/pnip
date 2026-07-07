import { describe, it, expect } from "vitest";
import { chunkSection, chunkAllSections } from "./chunking-service.js";
import type { ChunkableSection } from "./chunking-service.js";

function makeSection(overrides: Partial<ChunkableSection> & { id: string; document_id: string }): ChunkableSection {
  return {
    content_text: null,
    metadata: {},
    ...overrides,
  };
}

describe("chunkSection", () => {
  it("returns empty array for empty text", () => {
    const section = makeSection({ id: "s1", document_id: "d1", content_text: "" });
    expect(chunkSection(section, 0)).toEqual([]);
  });

  it("returns empty array for null text", () => {
    const section = makeSection({ id: "s1", document_id: "d1", content_text: null });
    expect(chunkSection(section, 0)).toEqual([]);
  });

  it("creates a single chunk from short text", () => {
    const section = makeSection({
      id: "s1",
      document_id: "d1",
      content_text: "Hello world",
    });
    const chunks = chunkSection(section, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Hello world");
    expect(chunks[0].sectionId).toBe("s1");
    expect(chunks[0].documentId).toBe("d1");
    expect(chunks[0].sequence).toBe(0);
    expect(chunks[0].paragraphStart).toBe(0);
    expect(chunks[0].paragraphEnd).toBe(0);
  });

  it("splits long text into multiple chunks", () => {
    const longPara = "word ".repeat(2000).trim();
    const section = makeSection({
      id: "s1",
      document_id: "d1",
      content_text: longPara,
    });
    const chunks = chunkSection(section, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].paragraphStart).toBe(0);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it("splits on paragraph boundaries", () => {
    const text = "Short para A.\n\nShort para B.\n\nShort para C.";
    const section = makeSection({ id: "s1", document_id: "d1", content_text: text });
    const chunks = chunkSection(section, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.text).toBeTruthy();
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.paragraphStart).toBeGreaterThanOrEqual(0);
      expect(chunk.paragraphEnd).toBeGreaterThanOrEqual(chunk.paragraphStart);
    }
  });

  it("preserves timestamp metadata on chunks", () => {
    const section = makeSection({
      id: "s1",
      document_id: "d1",
      content_text: "Some transcript text",
      metadata: { timestamp_start: 0, timestamp_end: 120.5 },
    });
    const chunks = chunkSection(section, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].timestampStart).toBe(0);
    expect(chunks[0].timestampEnd).toBe(120.5);
  });

  it("does not set timestamps when metadata lacks them", () => {
    const section = makeSection({
      id: "s1",
      document_id: "d1",
      content_text: "Plain text",
    });
    const chunks = chunkSection(section, 0);
    expect(chunks[0].timestampStart).toBeUndefined();
    expect(chunks[0].timestampEnd).toBeUndefined();
  });

  it("generates deterministic IDs", () => {
    const section = makeSection({ id: "s1", document_id: "d1", content_text: "Test" });
    const a = chunkSection(section, 0);
    const b = chunkSection(section, 0);
    expect(a[0].id).toBe(b[0].id);
  });

  it("generates different IDs for different sequences", () => {
    const section = makeSection({ id: "s1", document_id: "d1", content_text: "Test A\n\nTest B" });
    const chunks = chunkSection(section, 0);
    if (chunks.length > 1) {
      expect(chunks[0].id).not.toBe(chunks[1].id);
    }
  });
});

describe("chunkAllSections", () => {
  it("returns empty array for empty sections", () => {
    expect(chunkAllSections([])).toEqual([]);
  });

  it("sequences chunks across sections", () => {
    const sections = [
      makeSection({ id: "s1", document_id: "d1", content_text: "First section" }),
      makeSection({ id: "s2", document_id: "d1", content_text: "Second section" }),
    ];
    const chunks = chunkAllSections(sections);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sequence).toBe(0);
    expect(chunks[1].sequence).toBe(1);
    expect(chunks[0].sectionId).toBe("s1");
    expect(chunks[1].sectionId).toBe("s2");
  });

  it("skips sections with no content", () => {
    const sections = [
      makeSection({ id: "s1", document_id: "d1", content_text: "Has content" }),
      makeSection({ id: "s2", document_id: "d1", content_text: "" }),
      makeSection({ id: "s3", document_id: "d1", content_text: "More content" }),
    ];
    const chunks = chunkAllSections(sections);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sectionId).toBe("s1");
    expect(chunks[1].sectionId).toBe("s3");
  });
});
