import { createHash } from "node:crypto";
import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { EmbeddingProvider } from "../../ai/embedding-provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { EmbeddingRepository } from "./embedding-repository.js";

export interface EmbedChunkDeps {
  chunkRepo: ChunkRepository;
  embeddingRepo: EmbeddingRepository;
  embeddingProvider: EmbeddingProvider;
  provenanceRepo: ProvenanceRepository;
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

export function createEmbedChunkWorker(deps: EmbedChunkDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "embed_chunk";
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

      const inputHash = hashInput(found.content_text);

      const result = await deps.embeddingProvider.embed([found.content_text]);
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

      return {};
    },
  };
}
