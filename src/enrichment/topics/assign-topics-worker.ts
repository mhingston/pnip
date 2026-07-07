import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { TopicRepository } from "./topic-repository.js";
import { extractJson } from "../../common/json-extract.js";

const TOPICS_PROMPT_NAME = "topics";

export interface AssignTopicsDeps {
  chunkRepo: ChunkRepository;
  topicRepo: TopicRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
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

      const extracted = extractJson<TopicsResponse>(result.content);
      if (!extracted.ok) {
        throw new Error(`topics prompt returned non-JSON: ${extracted.error}`);
      }

      if (!isTopicArray(extracted.value.topics)) {
        throw new Error(
          "topics prompt JSON missing required field: { topics: [{ topic, confidence, relevance }] }",
        );
      }

      const normalized: { topic: string; confidence: number; relevance: number }[] = [];
      for (const raw of extracted.value.topics) {
        if (!isString(raw.topic) || !isUnitInterval(raw.confidence) || !isUnitInterval(raw.relevance)) {
          throw new Error(
            "topics prompt JSON has topic missing topic string or confidence/relevance in [0,1]",
          );
        }
        normalized.push({
          topic: raw.topic,
          confidence: raw.confidence,
          relevance: raw.relevance,
        });
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

      return {};
    },
  };
}
