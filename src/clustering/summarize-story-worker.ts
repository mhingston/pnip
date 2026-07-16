import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { ChunkRepository } from "../chunking/chunk-repository.js";
import type { SummaryRepository } from "../enrichment/summary/summary-repository.js";
import type { PromptRepository } from "../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../ai/prompt-execution.js";
import type { AiProvider } from "../ai/provider.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { StoryRepository } from "./story-repository.js";
import type { StorySummaryRepository } from "./story-summary-repository.js";
import type { SignalRepository, CreateSignalInput } from "../signals/signal-repository.js";
import { extractJson } from "../common/json-extract.js";
import { isFocusedYoutubeChannel } from "../expansion/youtube-channel-preferences.js";

const STORY_SUMMARY_PROMPT_NAME = "story_summary";
const YOUTUBE_STORY_SUMMARY_PROMPT_NAME = "youtube_story_summary";

const DEFAULT_MAX_CHUNKS_PER_DOC = 4;
const DEFAULT_MAX_CHARS_PER_CHUNK = 400;
const DETAILED_MAX_CHUNKS_PER_DOC = 8;
const DETAILED_MAX_CHARS_PER_CHUNK = 900;
const DETAILED_MAX_SOURCE_CHUNKS = 24;

export interface SummarizeStoryDeps {
  storyRepo: StoryRepository;
  storySummaryRepo: StorySummaryRepository;
  docRepo: DocumentRepository;
  chunkRepo: ChunkRepository;
  summaryRepo: SummaryRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
  signalRepo: SignalRepository;
  youtubeFocusChannels?: readonly string[];
  model?: string;
}

interface StorySummaryResponse {
  summary?: unknown;
  claims?: unknown;
}

interface SourceChunk {
  chunkId: string;
  documentId: string;
  text: string;
  title: string | null;
}

interface SummarizeStoryTarget {
  storyId: string;
}

function parseTarget(target: unknown): SummarizeStoryTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with storyId");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.storyId !== "string") {
    throw new Error("invalid target: missing storyId");
  }
  return { storyId: t.storyId };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

const CHUNK_REF_RE = /\[([^\]]*?)\]/g;
const CHUNK_NUM_RE = /chunk\s+(\d+)/gi;
const CHUNK_REF_CONTENT_RE = /^chunk\s+\d+(?:\s*,\s*chunk\s+\d+)*$/i;

function extractChunkReferences(
  claim: string,
  totalChunks: number,
  claimIndex: number,
): number[] {
  if (claim.trim().length === 0) {
    throw new Error(
      `story summary claim ${claimIndex + 1} must not be empty`,
    );
  }

  const matches = [...claim.matchAll(CHUNK_REF_RE)];
  if (matches.length === 0) {
    throw new Error(
      `story summary claim ${claimIndex + 1} must include an explicit chunk reference like [chunk 1]`,
    );
  }

  // Any square brackets left after removing reference groups are either an
  // unmatched bracket or an unrelated citation format. Reject both so the
  // persisted provenance can only come from the contract shown to the model.
  const withoutReferences = claim.replace(CHUNK_REF_RE, "");
  if (withoutReferences.includes("[") || withoutReferences.includes("]")) {
    throw new Error(
      `story summary claim ${claimIndex + 1} contains a malformed chunk reference; expected [chunk N] or [chunk N, chunk M]`,
    );
  }

  const out = new Set<number>();
  for (const m of matches) {
    const inner = (m[1] ?? "").trim();
    if (!CHUNK_REF_CONTENT_RE.test(inner)) {
      throw new Error(
        `story summary claim ${claimIndex + 1} contains malformed chunk reference '${m[0]}'`,
      );
    }

    for (const num of inner.matchAll(CHUNK_NUM_RE)) {
      const n = Number(num[1]);
      if (!Number.isFinite(n) || n < 1 || n > totalChunks) {
        throw new Error(
          `story summary claim ${claimIndex + 1} references chunk ${n}, but only chunks 1-${totalChunks} are available`,
        );
      }
      out.add(n - 1);
    }
  }

  if (out.size === 0) {
    throw new Error(
      `story summary claim ${claimIndex + 1} must include at least one valid chunk reference`,
    );
  }

  return [...out].sort((a, b) => a - b);
}

function stripReferences(claim: string): string {
  return claim
    .replace(CHUNK_REF_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeClaimText(claim: string): string {
  return claim
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const QUALITY_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "because",
  "been",
  "being",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "more",
  "not",
  "of",
  "on",
  "only",
  "that",
  "the",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "was",
  "were",
  "which",
  "with",
  "would",
]);

function meaningfulTokens(text: string): Set<string> {
  return new Set(
    (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
      .filter((token) => !QUALITY_STOP_WORDS.has(token)),
  );
}

function tokenOverlapCount(left: Set<string>, right: Set<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
}

function claimRestatesSummary(claim: string, summary: string): boolean {
  const claimTokens = meaningfulTokens(claim);
  if (claimTokens.size < 4) return false;
  const summaryTokens = meaningfulTokens(summary);
  return (
    tokenOverlapCount(claimTokens, summaryTokens) / claimTokens.size >= 0.8
  );
}

function claimHasSourceOverlap(
  claim: string,
  citedChunks: readonly SourceChunk[],
): boolean {
  const claimTokens = meaningfulTokens(claim);
  if (claimTokens.size < 3) return true;
  const sourceTokens = meaningfulTokens(citedChunks.map((c) => c.text).join(" "));
  return tokenOverlapCount(claimTokens, sourceTokens) > 0;
}

function selectEvenly<T>(items: readonly T[], maxItems: number): T[] {
  if (items.length <= maxItems) return [...items];
  if (maxItems <= 1) return [items[0]!];
  return Array.from({ length: maxItems }, (_, i) => {
    const index = Math.round((i * (items.length - 1)) / (maxItems - 1));
    return items[index]!;
  });
}

interface StoryClaim {
  text: string;
  chunkId: string;
}

function buildGroundedFallback(
  storyLabel: string,
  documentSummaries: readonly string[],
  sourceChunks: readonly SourceChunk[],
): { summary: string; claims: StoryClaim[] } {
  const firstChunk = sourceChunks[0];
  if (!firstChunk) {
    throw new Error(`cannot build story-summary fallback for '${storyLabel}' without source chunks`);
  }

  const sourceText = firstChunk.text
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const claimText = clip(sourceText || `The story concerns ${storyLabel}`, 500);
  const summary = clip(
    (documentSummaries[0] ?? claimText).replace(/\s+/g, " ").trim(),
    1200,
  );

  return {
    summary: summary || claimText,
    claims: [{
      text: `${claimText}${/[.!?]$/.test(claimText) ? "" : "."}`,
      chunkId: firstChunk.chunkId,
    }],
  };
}

export function createSummarizeStoryWorker(
  deps: SummarizeStoryDeps,
): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "summarize_story";
    },

    async execute(
      job: ProcessingJob,
      ctx: WorkerContext,
    ): Promise<WorkerOutcome> {
      const { storyId } = parseTarget(job.target);

      const story = await deps.storyRepo.getById(storyId);
      if (!story) {
        ctx.logger.warn("story not found, skipping", { storyId });
        return {};
      }

      const members = await deps.storyRepo.getMembers(storyId);
      if (members.length === 0) {
        ctx.logger.warn("story has no members, skipping", { storyId });
        return {};
      }

      const documentSummaries: string[] = [];
      let sourceChunks: SourceChunk[] = [];
      const chunkIdSet = new Set<string>();
      let detailedAnalysis = false;

      for (const member of members) {
        const doc = await deps.docRepo.getById(member.document_id);
        const title = doc?.title ?? null;
        const focusedYoutube = doc
          ? isFocusedYoutubeChannel(
              {
                sourceType: doc.source_type,
                metadata: doc.metadata,
                authors: doc.authors,
              },
              deps.youtubeFocusChannels,
            )
          : false;
        detailedAnalysis = detailedAnalysis || focusedYoutube;

        const summaries = await deps.summaryRepo.getByDocumentId(
          member.document_id,
        );
        if (summaries.length > 0) {
          const text = summaries.map((s) => s.content).join(" ");
          const heading = title ? `**${title}**: ` : "";
          documentSummaries.push(`${heading}${text}`);
        }

        const chunks = await deps.chunkRepo.getByDocumentIdOrdered(
          member.document_id,
        );
        const limited = focusedYoutube
          ? selectEvenly(chunks, DETAILED_MAX_CHUNKS_PER_DOC)
          : chunks.slice(0, DEFAULT_MAX_CHUNKS_PER_DOC);
        for (const c of limited) {
          if (chunkIdSet.has(c.id)) continue;
          chunkIdSet.add(c.id);
          sourceChunks.push({
            chunkId: c.id,
            documentId: c.document_id,
            text: c.content_text,
            title,
          });
        }
      }

      if (documentSummaries.length === 0 || sourceChunks.length === 0) {
        ctx.logger.warn("not enough source material for story, skipping", {
          storyId,
        });
        return {};
      }

      if (detailedAnalysis) {
        sourceChunks = selectEvenly(sourceChunks, DETAILED_MAX_SOURCE_CHUNKS);
      }

      const promptName = detailedAnalysis
        ? YOUTUBE_STORY_SUMMARY_PROMPT_NAME
        : STORY_SUMMARY_PROMPT_NAME;
      const prompt = await deps.promptRepo.getLatestVersion(promptName);
      if (!prompt) {
        throw new Error(
          `prompt '${promptName}' has no registered version; seed default prompts`,
        );
      }

      const chunkList = sourceChunks
        .map((c, i) =>
          clip(
            `[chunk ${i + 1} id=${c.chunkId}${detailedAnalysis && c.title ? ` source=${c.title}` : ""}] ${c.text}`,
            (detailedAnalysis
              ? DETAILED_MAX_CHARS_PER_CHUNK
              : DEFAULT_MAX_CHARS_PER_CHUNK) + 64,
          ),
        )
        .join("\n");

      const result = await deps.promptExecutor.execute({
        promptVersion: prompt,
        provider: deps.provider,
        model: deps.model,
        variables: {
          story_label: story.label,
          document_summaries: documentSummaries.join("\n\n"),
          source_chunks: chunkList,
        },
      });

      let summaryText: string;
      let parsedClaims: StoryClaim[];
      try {
        const extracted = extractJson<StorySummaryResponse>(result.content);
        if (!extracted.ok) {
          throw new Error(
            `story summary prompt returned non-JSON: ${extracted.error}`,
          );
        }
        const candidateSummary =
          typeof extracted.value.summary === "string"
            ? extracted.value.summary.trim()
            : "";
        const claims = isStringArray(extracted.value.claims)
          ? extracted.value.claims
          : [];
        if (!candidateSummary) {
          throw new Error("story summary prompt returned an empty summary");
        }
        if (claims.length === 0) {
          throw new Error("story summary prompt returned empty claims array");
        }

        const seenClaims = new Set<string>();
        parsedClaims = [];
        for (let i = 0; i < claims.length; i++) {
          const raw = claims[i]!;
          try {
            const refs = extractChunkReferences(raw, sourceChunks.length, i);
            const cleanText = stripReferences(raw);
            if (cleanText.length === 0) {
              throw new Error(
                `story summary claim ${i + 1} must contain text in addition to its chunk reference`,
              );
            }

            const normalized = normalizeClaimText(cleanText);
            if (seenClaims.has(normalized)) {
              throw new Error(
                `story summary prompt returned duplicate claim at position ${i + 1}`,
              );
            }
            seenClaims.add(normalized);

            const citedChunks = refs.map((ref) => sourceChunks[ref]!).filter(Boolean);
            if (!claimHasSourceOverlap(cleanText, citedChunks)) {
              throw new Error(
                `story summary claim ${i + 1} has no meaningful lexical overlap with its cited source chunks`,
              );
            }
            if (
              prompt.name === STORY_SUMMARY_PROMPT_NAME &&
              prompt.version >= 2 &&
              claimRestatesSummary(cleanText, candidateSummary)
            ) {
              throw new Error(
                `story summary claim ${i + 1} substantially restates the summary`,
              );
            }

            const primaryChunk = sourceChunks[refs[0]!];
            if (!primaryChunk) {
              throw new Error(
                `story summary claim ${i + 1} references a chunk that is not available in the prompt`,
              );
            }
            parsedClaims.push({
              text: cleanText,
              chunkId: primaryChunk.chunkId,
            });
          } catch (err) {
            ctx.logger.warn("discarding invalid story-summary claim", {
              storyId,
              claimIndex: i + 1,
              error: err as Error,
            });
          }
        }

        if (parsedClaims.length === 0) {
          throw new Error("story summary prompt produced no usable grounded claims");
        }
        summaryText = candidateSummary;
      } catch (err) {
        const fallback = buildGroundedFallback(
          story.label,
          documentSummaries,
          sourceChunks,
        );
        summaryText = fallback.summary;
        parsedClaims = fallback.claims;
        ctx.logger.warn("story-summary model output invalid; using grounded fallback", {
          storyId,
          error: err as Error,
        });
      }

      const { summary, citations } = await deps.storySummaryRepo.replaceForStory(
        {
          storyId,
          content: summaryText,
          promptId: result.promptId,
          promptVersion: result.promptVersion,
          model: result.model,
          provider: result.provider,
          inputHash: result.inputHash,
          claims: parsedClaims,
        },
      );

      for (const c of citations) {
        if (!c.chunk_id) continue;
        await deps.provenanceRepo.recordLineage({
          sourceType: "story",
          sourceId: storyId,
          targetType: "chunk",
          targetId: c.chunk_id,
          relation: "cite",
        });
      }

      await deps.provenanceRepo.recordLineage({
        sourceType: "story",
        sourceId: storyId,
        targetType: "story_summary",
        targetId: summary.id,
        relation: "summarized_by",
      });

      ctx.logger.info("story summary created", {
        storyId,
        summaryId: summary.id,
        claimCount: citations.length,
        detailedAnalysis,
      });

      const editionId = job.edition_id;
      if (editionId) {
        const signalInputs: CreateSignalInput[] = citations
          .filter((c) => c.chunk_id)
          .map((c) => ({
            signal_kind: "chunk_in_story",
            edition_id: editionId,
            story_id: storyId,
            chunk_id: c.chunk_id,
            source_url: null,
            source_identity: null,
            payload: { claim_text: c.claim_text },
          }));
        try {
          await deps.signalRepo.createBatch(signalInputs);
        } catch (err) {
          ctx.logger.warn("failed to insert chunk_in_story signals", {
            storyId,
            error: err as Error,
          });
        }
      }

      return {};
    },
  };
}
