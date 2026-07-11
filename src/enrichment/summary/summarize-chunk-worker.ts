import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob } from "../../database/kysely.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { SummaryRepository } from "./summary-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import { extractJson } from "../../common/json-extract.js";

const SUMMARY_PROMPT_NAME = "summary";
const ENRICHMENT_TYPE = "summarize_chunk";

export interface SummarizeChunkDeps {
  chunkRepo: ChunkRepository;
  summaryRepo: SummaryRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService;
  editionRepo: EditionRepository;
  model?: string;
}

interface SummaryResponse {
  summary?: unknown;
  claims?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
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

function chunkToLineageSource(chunk: DocumentChunkRow): { sourceType: string; sourceId: string } {
  return { sourceType: "chunk", sourceId: chunk.id };
}

export function createSummarizeChunkWorker(deps: SummarizeChunkDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "summarize_chunk";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("summarize_chunk job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping summarize_chunk", {
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

      const prompt = await deps.promptRepo.getLatestVersion(SUMMARY_PROMPT_NAME);
      if (!prompt) {
        throw new Error(
          `prompt '${SUMMARY_PROMPT_NAME}' has no registered version; seed default prompts`,
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

      const extracted = extractJson<SummaryResponse>(result.content);
      if (!extracted.ok) {
        throw new Error(`summary prompt returned non-JSON: ${extracted.error}`);
      }

      const summaryText =
        typeof extracted.value.summary === "string" ? extracted.value.summary : null;
      const claims = isStringArray(extracted.value.claims) ? extracted.value.claims : null;
      if (summaryText === null || claims === null) {
        throw new Error(
          "summary prompt JSON missing required fields: { summary: string, claims: string[] }",
        );
      }

      if (claims.length === 0) {
        throw new Error("summary prompt returned empty claims array");
      }

      const { summary, citations } = await deps.summaryRepo.replaceForChunk({
        chunkId,
        documentId,
        content: summaryText,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        model: result.model,
        provider: result.provider,
        inputHash: result.inputHash,
        claims: claims.map((text) => ({ text, chunkId })),
      });

      await deps.provenanceRepo.recordLineage({
        ...chunkToLineageSource(found),
        targetType: "summary",
        targetId: summary.id,
        relation: "summarized_by",
      });

      for (const c of citations) {
        await deps.provenanceRepo.recordLineage({
          sourceType: "summary",
          sourceId: summary.id,
          targetType: "chunk",
          targetId: c.chunk_id,
          relation: "cite",
        });
      }

      ctx.logger.info("summary created", {
        chunkId,
        documentId,
        summaryId: summary.id,
        claimCount: citations.length,
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
