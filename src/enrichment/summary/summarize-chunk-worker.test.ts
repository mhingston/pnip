import { describe, it, expect, vi } from "vitest";
import { createSummarizeChunkWorker } from "./summarize-chunk-worker.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider, ProviderTextResult } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { SummaryRepository } from "./summary-repository.js";
import type { ProcessingJob } from "../../database/kysely.js";
import type { PromptVersion } from "../../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "summarize_chunk",
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
    content_text: "Hello world. This is a test chunk.",
    token_count: 8,
    start_offset: 0,
    end_offset: 33,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makePromptVersion(): PromptVersion {
  return {
    id: "prompt-1",
    name: "summary",
    version: 1,
    template: "Summarize: {{chunk_text}}",
    purpose: "summarise chunks",
    created_at: new Date(),
  };
}

function makeDeps(overrides?: {
  chunk?: DocumentChunkRow | undefined;
  prompt?: PromptVersion | undefined;
  providerResult?: ProviderTextResult;
  providerError?: Error;
  executorResult?: Awaited<ReturnType<PromptExecutionService["execute"]>>;
  executorError?: Error;
}) {
  const chunkRepo: ChunkRepository = {
    createBatch: vi.fn(),
    getByDocumentId: vi.fn(),
    getBySectionId: vi.fn(),
    getByDocumentIdOrdered: vi.fn().mockResolvedValue(overrides?.chunk ? [overrides.chunk] : []),
    deleteByDocumentId: vi.fn(),
  };

  const summaryRepo: SummaryRepository = {
    replaceForChunk: vi.fn().mockResolvedValue({
      summary: {
        id: "summary-1",
        chunk_id: "chunk-1",
        document_id: "doc-1",
        content: "The chunk.",
        prompt_id: "prompt-1",
        prompt_version: 1,
        model: "fake",
        provider: "fake",
        input_hash: "h",
        created_at: new Date(),
      },
      citations: [
        {
          id: "cit-1",
          summary_id: "summary-1",
          chunk_id: "chunk-1",
          claim_text: "The chunk.",
          claim_order: 0,
          created_at: new Date(),
        },
      ],
    }),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn(),
    getCitationsBySummaryId: vi.fn(),
    deleteByChunkId: vi.fn(),
  };

  const promptRepo: PromptRepository = {
    create: vi.fn(),
    getById: vi.fn(),
    getByNameAndVersion: vi.fn(),
    getLatestVersion: vi.fn().mockImplementation(async () =>
      overrides && "prompt" in overrides ? overrides.prompt : makePromptVersion(),
    ),
    createNewVersion: vi.fn(),
    listByName: vi.fn(),
  };

  const promptExecutor: PromptExecutionService = {
    execute: overrides?.executorError
      ? vi.fn().mockRejectedValue(overrides.executorError)
      : vi.fn().mockResolvedValue(
          overrides?.executorResult ?? {
            content: '{"summary": "The chunk.", "claims": ["The chunk."]}',
            promptId: "prompt-1",
            promptVersion: 1,
            model: "fake",
            provider: "fake",
            inputHash: "h",
            createdAt: new Date().toISOString(),
          },
        ),
  };

  const provider: AiProvider = {
    name: "fake",
    generateText: vi.fn().mockResolvedValue(
      overrides?.providerResult ?? {
        content: "raw",
        model: "fake",
        provider: "fake",
      },
    ),
    embed: vi.fn(),
  };

  const provenanceRepo: ProvenanceRepository = {
    recordLineage: vi.fn().mockResolvedValue(undefined),
    recordLineageBatch: vi.fn(),
    getSources: vi.fn(),
    getConsumers: vi.fn(),
    resolveCitations: vi.fn(),
    resolveToDocuments: vi.fn(),
  };

  return { chunkRepo, summaryRepo, promptRepo, promptExecutor, provider, provenanceRepo };
}

describe("SummarizeChunkWorker", () => {
  it("supports summarize_chunk job type", () => {
    const deps = makeDeps();
    const worker = createSummarizeChunkWorker(deps);
    expect(worker.supports("summarize_chunk")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("renders prompt, parses JSON, persists summary + citations, records lineage", async () => {
    const deps = makeDeps({ chunk: makeChunk() });
    const worker = createSummarizeChunkWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptRepo.getLatestVersion).toHaveBeenCalledWith("summary");
    expect(deps.promptExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { chunk_text: "Hello world. This is a test chunk." },
      }),
    );
    expect(deps.summaryRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkId: "chunk-1",
        documentId: "doc-1",
        content: "The chunk.",
        claims: [{ text: "The chunk.", chunkId: "chunk-1" }],
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "chunk",
        sourceId: "chunk-1",
        targetType: "summary",
        targetId: "summary-1",
        relation: "summarized_by",
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "summary",
        sourceId: "summary-1",
        targetType: "chunk",
        targetId: "chunk-1",
        relation: "cite",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("skips when chunk is not found for the document", async () => {
    const deps = makeDeps({ chunk: undefined });
    const worker = createSummarizeChunkWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(deps.summaryRepo.replaceForChunk).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when summary prompt is not seeded", async () => {
    const deps = makeDeps({ chunk: makeChunk(), prompt: undefined });
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/no registered version/i);
  });

  it("throws when AI returns non-JSON", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorResult: {
        content: "not json at all",
        promptId: "prompt-1",
        promptVersion: 1,
        model: "fake",
        provider: "fake",
        inputHash: "h",
        createdAt: new Date().toISOString(),
      },
    });
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/non-JSON/);
    expect(deps.summaryRepo.replaceForChunk).not.toHaveBeenCalled();
  });

  it("throws when AI returns JSON missing required fields", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorResult: {
        content: '{"summary": "The chunk."}',
        promptId: "prompt-1",
        promptVersion: 1,
        model: "fake",
        provider: "fake",
        inputHash: "h",
        createdAt: new Date().toISOString(),
      },
    });
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("throws when claims array is empty", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorResult: {
        content: '{"summary": "The chunk.", "claims": []}',
        promptId: "prompt-1",
        promptVersion: 1,
        model: "fake",
        provider: "fake",
        inputHash: "h",
        createdAt: new Date().toISOString(),
      },
    });
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/empty claims array/);
  });

  it("propagates prompt executor errors", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorError: new Error("boom") });
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/boom/);
    expect(deps.summaryRepo.replaceForChunk).not.toHaveBeenCalled();
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createSummarizeChunkWorker(deps);

    await expect(
      worker.execute(makeJob({ target: null }), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/invalid target/i);
  });
});
