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


function extractChunkReferences(
  claim: string,
  totalChunks: number,
): number[] {
  const out = new Set<number>();
  for (const m of claim.matchAll(CHUNK_REF_RE)) {
    const inner = m[1];
    for (const num of inner.matchAll(CHUNK_NUM_RE)) {
      const n = Number(num[1]);
      if (Number.isFinite(n) && n >= 1 && n <= totalChunks) {
        out.add(n - 1);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function stripReferences(claim: string): string {
  return claim
    .replace(CHUNK_REF_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectEvenly<T>(items: readonly T[], maxItems: number): T[] {
  if (items.length <= maxItems) return [...items];
  if (maxItems <= 1) return [items[0]!];
  return Array.from({ length: maxItems }, (_, i) => {
    const index = Math.round((i * (items.length - 1)) / (maxItems - 1));
    return items[index]!;
  });
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

      const extracted = extractJson<StorySummaryResponse>(result.content);
      if (!extracted.ok) {
        throw new Error(
          `story summary prompt returned non-JSON: ${extracted.error}`,
        );
      }
      const summaryText =
        typeof extracted.value.summary === "string"
          ? extracted.value.summary
          : null;
      const claims = isStringArray(extracted.value.claims)
        ? extracted.value.claims
        : null;
      if (summaryText === null || claims === null) {
        throw new Error(
          "story summary prompt JSON missing required fields: { summary: string, claims: string[] }",
        );
      }
      if (claims.length === 0) {
        throw new Error("story summary prompt returned empty claims array");
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
          claims: claims.map((raw, i) => {
            const refs = extractChunkReferences(raw, sourceChunks.length);
            const primaryIdx =
              refs[0] ?? Math.min(i, sourceChunks.length - 1);
            const cleanText = stripReferences(raw);
            return {
              text: cleanText.length > 0 ? cleanText : raw,
              chunkId: sourceChunks[primaryIdx].chunkId,
            };
          }),
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
