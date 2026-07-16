import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { QualityRepository } from "./quality-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import { extractJson } from "../../common/json-extract.js";

const QUALITY_PROMPT_NAME = "quality";
const ENRICHMENT_TYPE = "classify_quality";

export interface ClassifyQualityDeps {
  chunkRepo: ChunkRepository;
  qualityRepo: QualityRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService;
  editionRepo: EditionRepository;
  model?: string;
}

interface QualityResponse {
  label?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
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

export function createClassifyQualityWorker(deps: ClassifyQualityDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "classify_quality";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("classify_quality job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping classify_quality", {
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
        await deps.promptRepo.getLatestVersion(QUALITY_PROMPT_NAME);
      if (!prompt) {
        throw new Error(
          `prompt '${QUALITY_PROMPT_NAME}' has no registered version; seed default prompts`,
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

      const extracted = extractJson<QualityResponse>(result.content);
      let label: string;
      let confidence: number;
      let reasoning: string | null;
      if (
        extracted.ok &&
        isString(extracted.value.label) &&
        extracted.value.label.trim().length > 0 &&
        isUnitInterval(extracted.value.confidence) &&
        isStringOrNull(extracted.value.reasoning)
      ) {
        label = extracted.value.label.trim();
        confidence = extracted.value.confidence;
        reasoning = extracted.value.reasoning;
      } else {
        ctx.logger.warn("quality prompt returned unusable output; using medium fallback", {
          chunkId,
          documentId,
          details: extracted.ok ? undefined : extracted.error,
        });
        label = "medium";
        confidence = 0;
        reasoning = "AI quality classification unavailable; defaulted to medium.";
      }

      const row = await deps.qualityRepo.replaceForChunk({
        chunkId,
        documentId,
        label,
        confidence,
        reasoning,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        model: result.model,
        provider: result.provider,
        inputHash: result.inputHash,
      });

      await deps.provenanceRepo.recordLineage({
        sourceType: "chunk",
        sourceId: chunkId,
        targetType: "quality_classification",
        targetId: row.id,
        relation: "classified_as",
      });

      ctx.logger.info("quality classified", {
        chunkId,
        documentId,
        label: row.label,
        confidence: row.confidence,
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
