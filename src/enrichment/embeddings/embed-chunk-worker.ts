import { createHash } from "node:crypto";
import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { DocumentRepository } from "../../expansion/document-repository.js";
import type { SummaryRepository } from "../summary/summary-repository.js";
import type { EmbeddingProvider } from "../../ai/embedding-provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { EmbeddingRepository } from "./embedding-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";

const ENRICHMENT_TYPE = "embed_chunk";

export interface EmbedChunkDeps {
  chunkRepo: ChunkRepository;
  docRepo: Pick<DocumentRepository, "getById">;
  summaryRepo: Pick<SummaryRepository, "getByChunkId">;
  embeddingRepo: EmbeddingRepository;
  embeddingProvider: EmbeddingProvider;
  provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService;
  editionRepo: EditionRepository;
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

function hashInput(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function embeddingText(title: string | null, summary: string): string {
  return `Title: ${title?.trim() || "Untitled"}\n\nSummary: ${summary.trim()}`;
}

export function createEmbedChunkWorker(deps: EmbedChunkDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "embed_chunk";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("embed_chunk job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping embed_chunk", {
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

      const [document, summary] = await Promise.all([
        deps.docRepo.getById(documentId),
        deps.summaryRepo.getByChunkId(chunkId),
      ]);
      // The embedding is deliberately document-oriented: title plus the
      // grounded summary is a substantially better clustering signal than a
      // raw excerpt. The summary is created by enrich_chunk before this job.
      const text = embeddingText(document?.title ?? null, summary?.content ?? found.content_text);
      const inputHash = hashInput(text);

      const result = await deps.embeddingProvider.embed([text]);
      const vector = result.vectors[0];
      if (!vector) {
        throw new Error("embedding provider returned no vector");
      }
      if (vector.length !== deps.embeddingProvider.dimension) {
        throw new Error(
          `embedding dimension mismatch: provider returned ${vector.length}, expected ${deps.embeddingProvider.dimension}`,
        );
      }

      const row = await deps.embeddingRepo.replaceForChunk({
        chunkId,
        vector,
        model: result.model,
        provider: result.provider,
        inputHash,
      });

      await deps.provenanceRepo.recordLineage({
        sourceType: "chunk",
        sourceId: chunkId,
        targetType: "embedding",
        targetId: row.id,
        relation: "embedded_as",
      });

      ctx.logger.info("embedding created", {
        chunkId,
        documentId,
        embeddingId: row.id,
        dimension: vector.length,
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
