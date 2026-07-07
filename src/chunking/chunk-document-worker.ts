import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SectionRepository, DocumentSectionRow } from "../expansion/section-repository.js";
import type { ChunkRepository } from "./chunk-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import { chunkAllSections, type ChunkableSection } from "./chunking-service.js";

const ENRICHMENT_JOB_TYPES = [
  "summarize_chunk",
  "extract_entities",
  "assign_topics",
  "embed_chunk",
  "classify_quality",
] as const;

interface ChunkTarget {
  documentId: string;
}

function parseTarget(target: unknown): ChunkTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with documentId");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.documentId !== "string") {
    throw new Error("invalid target: missing documentId");
  }
  return { documentId: t.documentId };
}

function toChunkableSection(row: DocumentSectionRow): ChunkableSection {
  return {
    id: row.id,
    document_id: row.document_id,
    content_text: row.content_text,
    metadata: row.metadata,
  };
}

export function createChunkDocumentWorker(deps: {
  docRepo: DocumentRepository;
  sectionRepo: SectionRepository;
  chunkRepo: ChunkRepository;
  provenanceRepo: ProvenanceRepository;
}): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "chunk_document";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { documentId } = parseTarget(job.target);

      const doc = await deps.docRepo.getById(documentId);
      if (!doc) {
        ctx.logger.warn("document not found, skipping", { documentId });
        return {};
      }

      const sections = await deps.sectionRepo.getByDocumentId(documentId);
      if (sections.length === 0) {
        ctx.logger.info("no sections to chunk", { documentId });
        return {};
      }

      const existing = await deps.chunkRepo.getByDocumentId(documentId);
      if (existing.length > 0) {
        ctx.logger.info("chunks already exist, replacing", {
          documentId,
          existingCount: existing.length,
        });
        await deps.chunkRepo.deleteByDocumentId(documentId);
      }

      const chunkInputs = chunkAllSections(sections.map(toChunkableSection));
      if (chunkInputs.length === 0) {
        ctx.logger.info("chunking produced no chunks", { documentId });
        return {};
      }

      const chunks = await deps.chunkRepo.createBatch(chunkInputs);
      ctx.logger.info("chunks created", { documentId, count: chunks.length });

      await deps.provenanceRepo.recordLineageBatch(
        chunks.map((c) => ({
          sourceType: "section",
          sourceId: c.section_id,
          targetType: "chunk",
          targetId: c.id,
          relation: "chunked_from",
        })),
      );

      const childJobs = chunks.flatMap((chunk) =>
        ENRICHMENT_JOB_TYPES.map((jobType) => ({
          jobType,
          editionId: doc.edition_id,
          target: { chunkId: chunk.id, documentId: doc.id },
        })),
      );

      return { childJobs };
    },
  };
}
