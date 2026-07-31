import type { EditorialItemBrief } from "./editorial-item-brief.js";
import type { EditorialPlan } from "./editorial-plan-schema.js";

export function createSingletonFallback(briefs: readonly EditorialItemBrief[]): EditorialPlan {
  const ordered = [...briefs].sort((a, b) => (b.sourcePriorityBoost - a.sourcePriorityBoost) || ((a.sourceTrustTier ?? 99) - (b.sourceTrustTier ?? 99)) || (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || a.documentId.localeCompare(b.documentId));
  return { stories: ordered.map((brief, index) => ({ key: `singleton-${index + 1}-${brief.documentId.slice(0, 8)}`, title: brief.title.slice(0, 160), documentIds: [brief.documentId], leadDocumentId: brief.documentId, importance: Math.max(0, Math.min(1, 1 - index / Math.max(1, ordered.length))), mergeReason: "singleton" as const })) };
}
