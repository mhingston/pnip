import { describe, it, expect, vi } from "vitest";
import { createEmbedChunkWorker } from "./embed-chunk-worker.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { EmbeddingProvider } from "../../ai/embedding-provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { EmbeddingRepository, EmbeddingRow } from "./embedding-repository.js";
import type { ProcessingJob } from "../../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "embed_chunk",
    edition_id: "edition-1",
    target: { chunkId: "chunk-1", documentId: "doc-1" },
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

function makeChunk(overrides?: Partial<DocumentChunkRow>): DocumentChunkRow {
  return {
    id: "chunk-1",
    document_id: "doc-1",
    section_id: "sec-1",
    chunk_sequence: 0,
    content_text: "Hello world.",
    token_count: 2,
    start_offset: 0,
    end_offset: 12,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeVector(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i + 1) / 100);
}

function makeDeps(overrides?: {
  chunk?: DocumentChunkRow | undefined;
  providerDim?: number;
  providerError?: Error;
  providerModel?: string;
  providerName?: string;
  embedding?: EmbeddingRow;
}) {
  const dimension = overrides?.providerDim ?? 8;

  const chunkRepo: ChunkRepository = {
    createBatch: vi.fn(),
    getByDocumentId: vi.fn(),
    getBySectionId: vi.fn(),
    getByDocumentIdOrdered: vi.fn().mockImplementation(async () =>
      overrides && "chunk" in overrides && overrides.chunk ? [overrides.chunk] : [],
    ),
    deleteByDocumentId: vi.fn(),
  };

  const embeddingProvider: EmbeddingProvider = {
    name: overrides?.providerName ?? "fake",
    dimension,
    embed: overrides?.providerError
      ? vi.fn().mockRejectedValue(overrides.providerError)
      : vi.fn().mockImplementation(async (texts: string[]) => ({
          vectors: texts.map(() => makeVector(dimension)),
          model: overrides?.providerModel ?? "fake-embed",
          provider: overrides?.providerName ?? "fake",
          dimension,
        })),
  };

  const embeddingRepo: EmbeddingRepository = {
    replaceForChunk: vi.fn().mockResolvedValue(
      overrides?.embedding ?? {
        id: "emb-1",
        chunk_id: "chunk-1",
        vector: makeVector(dimension),
        model: "fake-embed",
        provider: "fake",
        input_hash: "h",
        created_at: new Date(),
      },
    ),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn(),
    deleteByChunkId: vi.fn(),
  };

  const provenanceRepo: ProvenanceRepository = {
    recordLineage: vi.fn().mockResolvedValue(undefined),
    recordLineageBatch: vi.fn(),
    getSources: vi.fn(),
    getConsumers: vi.fn(),
    resolveCitations: vi.fn(),
    resolveToDocuments: vi.fn(),
  };

  return { chunkRepo, embeddingProvider, embeddingRepo, provenanceRepo };
}

describe("EmbedChunkWorker", () => {
  it("supports embed_chunk job type", () => {
    const deps = makeDeps();
    const worker = createEmbedChunkWorker(deps);
    expect(worker.supports("embed_chunk")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("embeds chunk text and records provenance", async () => {
    const deps = makeDeps({ chunk: makeChunk(), providerDim: 8 });
    const worker = createEmbedChunkWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.embeddingProvider.embed).toHaveBeenCalledWith(["Hello world."]);
    expect(deps.embeddingRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkId: "chunk-1",
        vector: expect.any(Array),
        model: "fake-embed",
        provider: "fake",
        inputHash: expect.any(String),
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "chunk",
        sourceId: "chunk-1",
        targetType: "embedding",
        targetId: "emb-1",
        relation: "embedded_as",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("computes deterministic input hash for chunk text", async () => {
    const deps = makeDeps({ chunk: makeChunk({ content_text: "Some text" }) });
    const worker = createEmbedChunkWorker(deps);

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    const arg = (deps.embeddingRepo.replaceForChunk as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("skips when chunk is not found for the document", async () => {
    const deps = makeDeps({ chunk: undefined });
    const worker = createEmbedChunkWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.embeddingProvider.embed).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when provider returns no vector", async () => {
    const deps = makeDeps({ chunk: makeChunk() });
    deps.embeddingProvider.embed = vi.fn().mockResolvedValue({
      vectors: [],
      model: "fake-embed",
      provider: "fake",
      dimension: 8,
    });
    const worker = createEmbedChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/no vector/);
  });

  it("throws when provider returns wrong dimension", async () => {
    const deps = makeDeps({ chunk: makeChunk(), providerDim: 16 });
    deps.embeddingProvider.embed = vi.fn().mockResolvedValue({
      vectors: [makeVector(8)],
      model: "fake-embed",
      provider: "fake",
      dimension: 8,
    });
    const worker = createEmbedChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/dimension mismatch/);
  });

  it("propagates provider errors", async () => {
    const deps = makeDeps({ chunk: makeChunk(), providerError: new Error("boom") });
    const worker = createEmbedChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createEmbedChunkWorker(deps);

    await expect(
      worker.execute(makeJob({ target: null }), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/invalid target/i);
  });
});
