import type { Logger } from "../logging/logger.js";
import type { PromptRepository } from "./prompt-repository.js";
import { PromptVersionConflictError } from "./prompt-repository.js";

export interface PromptDefinition {
  name: string;
  purpose: string;
  template: string;
  version?: number;
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
- "summary": a concise 3-6 sentence news summary synthesising the source documents into a single coherent narrative. Write as a journalist — report the facts, events, and implications. Do NOT mention "documents", "chunks", "sources", or the story label. Do NOT start with "Story:" or restate the label. Just write the news.
- "claims": an array of one or more atomic claims extracted from the summary (each a complete sentence) that are supported by the source documents. For every claim, append the source chunk indices that support it in square brackets, e.g. "The Federal Reserve raised rates [chunk 2, chunk 5]."

The summary's claims must be supported by the provided document text. Each claim must reference at least one source chunk by its index as shown in the "Source chunks" list. Return ONLY the JSON object, no prose.

Story label (for reference only — do NOT restate this in the summary): {{story_label}}

Document summaries:
{{document_summaries}}

Source chunks:
{{source_chunks}}`,
  },
  {
    name: "story_summary",
    version: 3,
    purpose: "Per-story master summary with abstractive claims (no summary exposure)",
    template: `You are writing a master summary of a news story that groups together multiple source documents. Produce a JSON object with two fields:
- "summary": a concise 3-6 sentence news summary synthesising the source documents into a single coherent narrative. Write as a journalist — report the facts, events, and implications. Do NOT mention "documents", "chunks", "sources", or the story label. Do NOT start with "Story:" or restate the label. Just write the news.
- "claims": an array of 4-8 atomic claims, each one a SPECIFIC FACT that a reader of the summary would NOT already know. Each claim MUST be:
    1. A single complete sentence with a clear subject, verb, and object.
    2. INFORMATION that is NOT in the summary above. Do NOT restate or paraphrase anything the summary already says. If a sentence in the summary says "X launched Y", the claim must say something different about Y that the summary does NOT say.
    3. Supported by the source chunks below. End with the source chunk indices in square brackets, e.g. "The Federal Reserve raised rates by 25 basis points in March 2024 [chunk 2, chunk 5]."
  Examples of good claims (study these, do not copy them):
    - "Anthropic was founded in 2021 by Dario Amodei and Daniela Amodei after they left OpenAI." (specific date, specific named people — not in summary)
    - "OpenAI's 2024 revenue is estimated at $3.4 billion, up from $1.3 billion in 2023." (specific numbers, comparison — not in summary)
    - "The new release ships with an MIT license, a reversal from the company's prior proprietary stance." (specific implication, comparison — not in summary)
  Examples of BAD claims (do NOT write these):
    - Anything that repeats a sentence from the summary above.
    - Anything that paraphrases a summary sentence (changing a few words but keeping the same meaning).
    - Vague claims with no specific entity, date, or number (e.g. "The company is growing fast.").

Story label (for reference only — do NOT restate this in the summary): {{story_label}}

Source chunks (these are your ONLY source of facts; do not invent any):
{{source_chunks}}`,
  },
  {
    name: "story_summary",
    version: 2,
    purpose: "Per-story master summary with abstractive claims (deprecated — use v3)",
    template: `You are writing a master summary of a news story that groups together multiple source documents. Produce a JSON object with two fields:
- "summary": a concise 3-6 sentence news summary synthesising the source documents into a single coherent narrative. Write as a journalist — report the facts, events, and implications. Do NOT mention "documents", "chunks", "sources", or the story label. Do NOT start with "Story:" or restate the label. Just write the news.
- "claims": an array of one or more atomic, ABSTRACTIVE claims — facts that add NEW information beyond the summary. Each claim MUST:
    1. Be a single complete sentence with a clear subject, verb, and object.
    2. Add information that is NOT already in the summary — for example, a named entity, a specific date, a specific number, a specific person or company, an implication or consequence, OR a comparison between two things.
    3. Be supported by the source documents.
    4. End with the source chunk indices in square brackets, e.g. "The Federal Reserve raised rates by 25 basis points in March 2024 [chunk 2, chunk 5]."
  DO NOT include claims that are direct quotes, close paraphrases, or simple restatements of sentences in the summary. Each claim must add NEW information that is not already in the summary.

The summary's claims must be supported by the provided document text. Each claim must reference at least one source chunk by its index as shown in the "Source chunks" list. Return ONLY the JSON object, no prose.

Story label (for reference only — do NOT restate this in the summary): {{story_label}}

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
    if (def.version !== undefined) {
      const existing = await promptRepo.getByNameAndVersion(
        def.name,
        def.version,
      );
      if (existing) {
        logger?.debug("prompt version already seeded, skipping", {
          name: def.name,
          version: existing.version,
        });
        results.push({
          name: def.name,
          status: "skipped",
          version: existing.version,
        });
        continue;
      }
      try {
        const created = await promptRepo.create({
          name: def.name,
          version: def.version,
          template: def.template,
          purpose: def.purpose,
        });
        logger?.info("prompt version seeded", {
          name: created.name,
          version: created.version,
        });
        results.push({
          name: created.name,
          status: "created",
          version: created.version,
        });
      } catch (err) {
        if (err instanceof PromptVersionConflictError) {
          results.push({
            name: def.name,
            status: "skipped",
            version: def.version,
          });
          continue;
        }
        throw err;
      }
      continue;
    }

    const existing = await promptRepo.getLatestVersion(def.name);
    if (existing) {
      logger?.debug("prompt already seeded, skipping", {
        name: def.name,
        version: existing.version,
      });
      results.push({
        name: def.name,
        status: "skipped",
        version: existing.version,
      });
      continue;
    }
    const created = await promptRepo.createNewVersion({
      name: def.name,
      template: def.template,
      purpose: def.purpose,
    });
    logger?.info("prompt seeded", {
      name: created.name,
      version: created.version,
    });
    results.push({
      name: created.name,
      status: "created",
      version: created.version,
    });
  }
  const summary: SeedSummary = {
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  };
  return summary;
}