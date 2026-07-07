import type { Logger } from "../logging/logger.js";
import type { PromptRepository } from "./prompt-repository.js";

export interface PromptDefinition {
  name: string;
  purpose: string;
  template: string;
}

export const DEFAULT_PROMPTS: readonly PromptDefinition[] = [
  {
    name: "summary",
    purpose: "Per-chunk summary with claim citations",
    template: `You are summarising a single chunk of a document. Produce a JSON object with two fields:
- "summary": a concise 1-3 sentence summary of the chunk text
- "claims": an array of one or more atomic claims extracted from the summary (each a complete sentence)

The summary's claims must be supported by this chunk. Return ONLY the JSON object, no prose.

Chunk text:
{{chunk_text}}`,
  },
  {
    name: "entities",
    purpose: "Per-chunk named-entity extraction",
    template: `You are extracting named entities from a single chunk of a document. Produce a JSON object with one field:
- "entities": an array of objects, each with:
  - "name": the canonical entity name
  - "type": one of "person", "organization", "location", "product", "event", "concept"
  - "mention": the exact surface form from the chunk text
Return an empty array if no entities are found. Return ONLY the JSON object, no prose.

Chunk text:
{{chunk_text}}`,
  },
  {
    name: "topics",
    purpose: "Per-chunk topic assignment with confidence and relevance",
    template: `You are assigning topics to a single chunk of a document. Produce a JSON object with one field:
- "topics": an array of objects, each with:
  - "topic": a short lowercase topic phrase (2-4 words)
  - "confidence": number in [0, 1], your overall confidence the topic is meaningful
  - "relevance": number in [0, 1], how relevant the topic is to this chunk
Return 1-5 topics. Return ONLY the JSON object, no prose.

Chunk text:
{{chunk_text}}`,
  },
  {
    name: "quality",
    purpose: "Per-chunk quality classification",
    template: `You are classifying the quality of a single chunk of a document. Produce a JSON object with:
- "label": one of "high", "medium", "low"
- "confidence": number in [0, 1]
- "reasoning": a brief one-sentence explanation (may be null)

Return ONLY the JSON object, no prose.

Chunk text:
{{chunk_text}}`,
  },
  {
    name: "story_summary",
    purpose: "Per-story master summary with chunk citations",
    template: `You are writing a master summary of a news story that groups together multiple source documents. Produce a JSON object with two fields:
- "summary": a concise 3-6 sentence summary synthesising the documents into a single coherent narrative
- "claims": an array of one or more atomic claims extracted from the summary (each a complete sentence) that are supported by the source documents. For every claim, append the source chunk indices that support it in square brackets, e.g. "The Federal Reserve raised rates [chunk 2, chunk 5]."

The summary's claims must be supported by the provided document text. Each claim must reference at least one source chunk by its index as shown in the "Source chunks" list. Return ONLY the JSON object, no prose.

Story label: {{story_label}}

Document summaries:
{{document_summaries}}

Source chunks:
{{source_chunks}}`,
  },
];

export interface SeedResult {
  name: string;
  status: "created" | "skipped";
  version: number;
}

export interface SeedSummary {
  created: number;
  skipped: number;
  results: SeedResult[];
}

export async function seedDefaultPrompts(
  promptRepo: PromptRepository,
  logger?: Logger,
): Promise<SeedSummary> {
  const results: SeedResult[] = [];
  for (const def of DEFAULT_PROMPTS) {
    const existing = await promptRepo.getLatestVersion(def.name);
    if (existing) {
      logger?.debug("prompt already seeded, skipping", {
        name: def.name,
        version: existing.version,
      });
      results.push({ name: def.name, status: "skipped", version: existing.version });
      continue;
    }
    const created = await promptRepo.createNewVersion({
      name: def.name,
      template: def.template,
      purpose: def.purpose,
    });
    logger?.info("prompt seeded", { name: created.name, version: created.version });
    results.push({ name: created.name, status: "created", version: created.version });
  }
  const summary: SeedSummary = {
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  };
  return summary;
}
