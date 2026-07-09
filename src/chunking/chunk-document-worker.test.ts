import { describe, it, expect, vi } from "vitest";
import { createChunkDocumentWorker } from "./chunk-document-worker.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SectionRepository, DocumentSectionRow } from "../expansion/section-repository.js";
import type { ChunkRepository, DocumentChunkRow } from "./chunk-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { EnrichmentTrackerRepository } from "../editions/enrichment-tracker-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { ProcessingJob } from "../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "chunk_document",
    edition_id: "edition-1",
    target: { documentId: "doc-1" },
    status: "running",
    retry_count: 0,
    last_error: null,
    last_attempt_at: null,
    next_eligible_at: new Date(),
    locked_by: "worker-1",
    locked_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    depends_on: [],
    ...overrides,
  };
}

function makeSectionRow(overrides?: Partial<DocumentSectionRow>): DocumentSectionRow {
  return {
    id: "sec-1",
    document_id: "doc-1",
    section_order: 0,
    heading: null,
    section_type: "paragraph",
    content_markdown: null,
    content_text: "Hello world",
    metadata: {},
    created_at: new Date(),
    ...overrides,
  };
}

function makeChunkRow(overrides?: Partial<DocumentChunkRow>): DocumentChunkRow {
  return {
    id: "chunk-a1b2c3d4",
    document_id: "doc-1",
    section_id: "sec-1",
    chunk_sequence: 0,
    content_text: "Hello world",
    token_count: 3,
    start_offset: 0,
    end_offset: 11,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeEnrichmentTracker(): EnrichmentTrackerRepository {
  return {
    markDone: vi.fn().mockResolvedValue({
      document_id: "doc-1",
      enrichment_type: "summarize_chunk",
      status: "done",
      completed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }),
    resetForDocument: vi.fn().mockResolvedValue(undefined),
    getCompletedTypesForDocument: vi.fn().mockResolvedValue([]),
    isDocumentFullyEnriched: vi.fn().mockResolvedValue(false),
    getDocumentCounts: vi.fn().mockResolvedValue({
      totalDocuments: 0,
      fullyEnrichedDocuments: 0,
      totalCompletedTypeRows: 0,
      expectedTypeRows: 0,
    }),
    isEditionFullyEnriched: vi.fn().mockResolvedValue(false),
    getEditionEnqueuedAt: vi.fn().mockResolvedValue(null),
    claimEditionEnqueue: vi.fn().mockResolvedValue(null),
    resetEditionEnqueue: vi.fn().mockResolvedValue(undefined),
  };
}

function silentLogger(): any {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeEditionRepo(allowed = true): EditionRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    getByDate: vi.fn(),
    getOrCreateForDate: vi.fn(),
    transition: vi.fn(),
    isProcessingAllowed: vi.fn().mockResolvedValue(allowed),
    assertProcessingAllowed: vi.fn(),
  };
}

describe("ChunkDocumentWorker", () => {
  it("supports chunk_document job type", () => {
    const worker = createChunkDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      chunkRepo: {} as ChunkRepository,
      provenanceRepo: {} as ProvenanceRepository,
      enrichmentTracker: makeEnrichmentTracker(),
      editionRepo: makeEditionRepo(),
    });
    expect(worker.supports("chunk_document")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("warns and returns empty when document not found", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue(undefined),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
      getByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn(),
      getById: vi.fn(),
      getByDocumentId: vi.fn(),
      getBySectionId: vi.fn(),
      getByDocumentIdOrdered: vi.fn(),
      deleteByDocumentId: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };
    const enrichmentTracker = makeEnrichmentTracker();
    const editionRepo = makeEditionRepo();

    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome).toEqual({});
    expect(chunkRepo.createBatch).not.toHaveBeenCalled();
    expect(enrichmentTracker.resetForDocument).not.toHaveBeenCalled();
  });

  it("warns and returns empty when no sections exist", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
      getByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn(),
      getById: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getBySectionId: vi.fn(),
      getByDocumentIdOrdered: vi.fn(),
      deleteByDocumentId: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };
    const enrichmentTracker = makeEnrichmentTracker();
    const editionRepo = makeEditionRepo();

    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome).toEqual({});
    expect(chunkRepo.createBatch).not.toHaveBeenCalled();
  });

  it("chunks sections and returns 5 enrichment child jobs (no eager cluster_stories)", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
      getByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([makeSectionRow()]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn().mockResolvedValue([makeChunkRow()]),
      getById: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getBySectionId: vi.fn(),
      getByDocumentIdOrdered: vi.fn(),
      deleteByDocumentId: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn().mockResolvedValue(undefined),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };
    const enrichmentTracker = makeEnrichmentTracker();
    const editionRepo = makeEditionRepo();

    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(chunkRepo.getByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.createBatch).toHaveBeenCalled();
    expect(chunkRepo.deleteByDocumentId).not.toHaveBeenCalled();
    expect(enrichmentTracker.resetForDocument).not.toHaveBeenCalled();

    const childJobs = outcome.childJobs;
    expect(childJobs).toBeDefined();
    expect(childJobs).toHaveLength(5);
    expect(childJobs!.map((j) => j.jobType).sort()).toEqual(
      ["assign_topics", "classify_quality", "embed_chunk", "extract_entities", "summarize_chunk"],
    );
    expect(childJobs!.map((j) => j.jobType)).not.toContain("cluster_stories");

    for (const job of childJobs!) {
      expect(job.editionId).toBe("edition-1");
      expect(job.target).toEqual({ chunkId: "chunk-a1b2c3d4", documentId: "doc-1" });
    }

    expect(provenanceRepo.recordLineageBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "section",
          sourceId: "sec-1",
          targetType: "chunk",
          targetId: "chunk-a1b2c3d4",
          relation: "chunked_from",
        }),
      ]),
    );
  });

  it("deletes existing chunks, resets the enrichment tracker, and re-chunks on re-chunk", async () => {
    const existing = makeChunkRow({ id: "old-chunk" });
    const replacement = makeChunkRow();

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
      getByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([makeSectionRow()]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn().mockResolvedValue([replacement]),
      getById: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([existing]),
      getBySectionId: vi.fn(),
      getByDocumentIdOrdered: vi.fn(),
      deleteByDocumentId: vi.fn().mockResolvedValue(undefined),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };
    const enrichmentTracker = makeEnrichmentTracker();
    const editionRepo = makeEditionRepo();

    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(chunkRepo.getByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.deleteByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.createBatch).toHaveBeenCalled();
    expect(enrichmentTracker.resetForDocument).toHaveBeenCalledWith("doc-1");
    expect(enrichmentTracker.resetForDocument).toHaveBeenCalledTimes(1);
  });

  it("skips when edition is not in a mutable state (state guard)", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
      getByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([makeSectionRow()]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn().mockResolvedValue([makeChunkRow()]),
      getById: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getBySectionId: vi.fn(),
      getByDocumentIdOrdered: vi.fn(),
      deleteByDocumentId: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };
    const enrichmentTracker = makeEnrichmentTracker();
    const editionRepo = makeEditionRepo(false);

    const worker = createChunkDocumentWorker({
      docRepo,
      sectionRepo,
      chunkRepo,
      provenanceRepo,
      enrichmentTracker,
      editionRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome).toEqual({});
    expect(editionRepo.isProcessingAllowed).toHaveBeenCalledWith("edition-1");
    expect(chunkRepo.createBatch).not.toHaveBeenCalled();
    expect(chunkRepo.deleteByDocumentId).not.toHaveBeenCalled();
    expect(enrichmentTracker.resetForDocument).not.toHaveBeenCalled();
    expect(provenanceRepo.recordLineageBatch).not.toHaveBeenCalled();
  });

  it("throws on invalid target", async () => {
    const worker = createChunkDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      chunkRepo: {} as ChunkRepository,
      provenanceRepo: {} as ProvenanceRepository,
      enrichmentTracker: makeEnrichmentTracker(),
      editionRepo: makeEditionRepo(),
    });

    await expect(
      worker.execute(makeJob({ target: null }), {
        db: {} as any,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/invalid target/i);
  });
});
