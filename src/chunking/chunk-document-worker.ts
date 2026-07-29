import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SectionRepository, DocumentSectionRow } from "../expansion/section-repository.js";
import type { ChunkRepository } from "./chunk-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { EnrichmentTrackerRepository } from "../editions/enrichment-tracker-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import { chunkDocumentSections, type ChunkableSection } from "./chunking-service.js";

const ENRICHMENT_JOB_TYPES = [
  "enrich_chunk",
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
  enrichmentTracker: EnrichmentTrackerRepository;
  editionRepo: EditionRepository;
}): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "chunk_document";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("chunk_document job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping chunk_document", {
          editionId,
          documentId,
        });
        return {};
      }

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
        await deps.enrichmentTracker.resetForDocument(documentId);
      }

      const chunkInputs = chunkDocumentSections(sections.map(toChunkableSection));
      if (chunkInputs.length === 0) {
        ctx.logger.info("chunking produced no chunks", { documentId });
        return {};
      }

      const chunks = await deps.chunkRepo.createBatch(chunkInputs);
      ctx.logger.info("chunks created", { documentId, count: chunks.length });

      // The compact, document-level chunk intentionally contains all normal
      // sections. Record each source section, rather than only the section
      // used to satisfy document_chunks.section_id, so provenance remains
      // complete for multi-section articles.
      const lineageSources = chunks.length === 1
        ? sections.map((section) => ({ sourceId: section.id, targetId: chunks[0]!.id }))
        : chunks.map((chunk) => ({ sourceId: chunk.section_id, targetId: chunk.id }));
      await deps.provenanceRepo.recordLineageBatch(
        lineageSources.map(({ sourceId, targetId }) => ({
          sourceType: "section",
          sourceId,
          targetType: "chunk",
          targetId,
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
