import { describe, it, expect, vi } from "vitest";
import { createChunkDocumentWorker } from "./chunk-document-worker.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SectionRepository, DocumentSectionRow } from "../expansion/section-repository.js";
import type { ChunkRepository, DocumentChunkRow } from "./chunk-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
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

describe("ChunkDocumentWorker", () => {
  it("supports chunk_document job type", () => {
    const worker = createChunkDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      chunkRepo: {} as ChunkRepository,
      provenanceRepo: {} as ProvenanceRepository,
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
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn(),
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

    const worker = createChunkDocumentWorker({
      docRepo, sectionRepo, chunkRepo, provenanceRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(outcome).toEqual({});
    expect(chunkRepo.createBatch).not.toHaveBeenCalled();
  });

  it("warns and returns empty when no sections exist", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn(),
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

    const worker = createChunkDocumentWorker({
      docRepo, sectionRepo, chunkRepo, provenanceRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(outcome).toEqual({});
    expect(chunkRepo.createBatch).not.toHaveBeenCalled();
  });

  it("chunks sections and returns enrichment child jobs", async () => {
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([makeSectionRow()]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn().mockResolvedValue([makeChunkRow()]),
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

    const worker = createChunkDocumentWorker({
      docRepo, sectionRepo, chunkRepo, provenanceRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(chunkRepo.getByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.createBatch).toHaveBeenCalled();
    expect(chunkRepo.deleteByDocumentId).not.toHaveBeenCalled();

    const childJobs = outcome.childJobs;
    expect(childJobs).toBeDefined();
    expect(childJobs).toHaveLength(6);

    const jobTypes = childJobs!.map((j) => j.jobType);
    expect(jobTypes).toContain("summarize_chunk");
    expect(jobTypes).toContain("extract_entities");
    expect(jobTypes).toContain("assign_topics");
    expect(jobTypes).toContain("embed_chunk");
    expect(jobTypes).toContain("classify_quality");
    expect(jobTypes).toContain("cluster_stories");

    for (const job of childJobs!) {
      expect(job.editionId).toBe("edition-1");
    }

    const enrichmentJobs = childJobs!.filter((j) => j.jobType !== "cluster_stories");
    for (const job of enrichmentJobs) {
      expect(job.target).toEqual({ chunkId: "chunk-a1b2c3d4", documentId: "doc-1" });
    }

    const clusterJob = childJobs!.find((j) => j.jobType === "cluster_stories");
    expect(clusterJob?.target).toEqual({ editionId: "edition-1" });

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

  it("deletes and replaces chunks when they already exist", async () => {
    const existing = makeChunkRow({ id: "old-chunk" });
    const replacement = makeChunkRow();

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1" }),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([makeSectionRow()]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const chunkRepo: ChunkRepository = {
      createBatch: vi.fn().mockResolvedValue([replacement]),
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

    const worker = createChunkDocumentWorker({
      docRepo, sectionRepo, chunkRepo, provenanceRepo,
    });

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(chunkRepo.getByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.deleteByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(chunkRepo.createBatch).toHaveBeenCalled();
  });

  it("throws on invalid target", async () => {
    const worker = createChunkDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      chunkRepo: {} as ChunkRepository,
      provenanceRepo: {} as ProvenanceRepository,
    });

    await expect(
      worker.execute(makeJob({ target: null }), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/invalid target/i);
  });
});
