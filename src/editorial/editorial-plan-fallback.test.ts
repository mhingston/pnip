import { describe, expect, it } from "vitest";
import { createSingletonFallback } from "./editorial-plan-fallback.js";
import type { EditorialItemBrief } from "./editorial-item-brief.js";

const brief = (documentId: string, boost: number): EditorialItemBrief => ({ documentId, title: documentId, sourceUrl: documentId, canonicalUrl: null, sourceType: "article", publisher: null, authors: [], publishedAt: null, summary: "", evidence: [], sourceIdentity: null, sourceTrustTier: 2, sourcePriorityBoost: boost });

describe("editorial singleton fallback", () => {
  it("accounts for every document in stable priority order", () => {
    const result = createSingletonFallback([brief("b", 0), brief("a", 2)]);
    expect(result.stories.map((s) => s.documentIds[0])).toEqual(["a", "b"]);
    expect(result.stories.every((s) => s.mergeReason === "singleton")).toBe(true);
  });
});
