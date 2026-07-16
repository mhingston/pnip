import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { TopicRepository } from "./topic-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import { extractJson } from "../../common/json-extract.js";

const TOPICS_PROMPT_NAME = "topics";
const ENRICHMENT_TYPE = "assign_topics";

export interface AssignTopicsDeps {
  chunkRepo: ChunkRepository;
  topicRepo: TopicRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService;
  editionRepo: EditionRepository;
  model?: string;
}

interface TopicsResponse {
  topics?: unknown;
}

interface RawTopic {
  topic: unknown;
  confidence: unknown;
  relevance: unknown;
}

function isTopicArray(v: unknown): v is RawTopic[] {
  return Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isUnitInterval(v: unknown): v is number {
  return typeof v === "number" && v >= 0 && v <= 1 && Number.isFinite(v);
}

interface ChunkTarget {
  chunkId: string;
  documentId: string;
}

function parseTarget(target: unknown): ChunkTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with chunkId and documentId");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.chunkId !== "string" || typeof t.documentId !== "string") {
    throw new Error("invalid target: missing chunkId or documentId");
  }
  return { chunkId: t.chunkId, documentId: t.documentId };
}

export function createAssignTopicsWorker(deps: AssignTopicsDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "assign_topics";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("assign_topics job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping assign_topics", {
          editionId,
          documentId,
          chunkId,
        });
        return {};
      }

      const chunk = await deps.chunkRepo.getByDocumentIdOrdered(documentId);
      const found = chunk.find((c) => c.id === chunkId);
      if (!found) {
        ctx.logger.warn("chunk not found for document, skipping", {
          chunkId,
          documentId,
        });
        return {};
      }

      const prompt: PromptVersion | undefined =
        await deps.promptRepo.getLatestVersion(TOPICS_PROMPT_NAME);
      if (!prompt) {
        throw new Error(
          `prompt '${TOPICS_PROMPT_NAME}' has no registered version; seed default prompts`,
        );
      }

      const result = await deps.promptExecutor.execute({
        promptVersion: prompt,
        provider: deps.provider,
        model: deps.model,
        variables: {
          chunk_text: found.content_text,
        },
      });

      const normalized: { topic: string; confidence: number; relevance: number }[] = [];
      const extracted = extractJson<TopicsResponse>(result.content);
      if (!extracted.ok) {
        ctx.logger.warn("topics prompt returned unusable JSON; using empty topic fallback", {
          chunkId,
          documentId,
          details: extracted.error,
        });
      } else if (!isTopicArray(extracted.value.topics)) {
        ctx.logger.warn("topics prompt omitted its topic array; using empty topic fallback", {
          chunkId,
          documentId,
        });
      } else {
        let invalidCount = 0;
        for (const raw of extracted.value.topics) {
          if (
            !isString(raw.topic) ||
            raw.topic.trim().length === 0 ||
            !isUnitInterval(raw.confidence) ||
            !isUnitInterval(raw.relevance)
          ) {
            invalidCount++;
            continue;
          }
          normalized.push({
            topic: raw.topic.trim(),
            confidence: raw.confidence,
            relevance: raw.relevance,
          });
        }
        if (invalidCount > 0) {
          ctx.logger.warn("invalid topics omitted from enrichment result", {
            chunkId,
            documentId,
            invalidCount,
          });
        }
      }

      const { topics, assignments } = await deps.topicRepo.replaceForChunk({
        chunkId,
        documentId,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        model: result.model,
        provider: result.provider,
        inputHash: result.inputHash,
        topics: normalized,
      });

      for (const t of topics) {
        await deps.provenanceRepo.recordLineage({
          sourceType: "chunk",
          sourceId: chunkId,
          targetType: "topic",
          targetId: t.id,
          relation: "assigned_to",
        });
      }

      for (const a of assignments) {
        await deps.provenanceRepo.recordLineage({
          sourceType: "topic",
          sourceId: a.topic_id,
          targetType: "chunk",
          targetId: a.chunk_id,
          relation: "covers",
        });
      }

      ctx.logger.info("topics assigned", {
        chunkId,
        documentId,
        topicCount: topics.length,
      });

      const childJob = await deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster(
        editionId,
        documentId,
        ENRICHMENT_TYPE,
        chunkId,
      );
      return childJob ? { childJobs: [childJob] } : {};
    },
  };
}
