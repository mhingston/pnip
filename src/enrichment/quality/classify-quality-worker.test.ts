import { describe, it, expect, vi } from "vitest";
import { createClassifyQualityWorker } from "./classify-quality-worker.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type {
  QualityRepository,
  QualityClassificationRow,
} from "./quality-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "classify_quality",
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

function makeChunk(): DocumentChunkRow {
  return {
    id: "chunk-1",
    document_id: "doc-1",
    section_id: "sec-1",
    chunk_sequence: 0,
    content_text: "A useful article.",
    token_count: 4,
    start_offset: 0,
    end_offset: 16,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
  };
}

function makePrompt(): PromptVersion {
  return {
    id: "prompt-1",
    name: "quality",
    version: 1,
    template: "Quality: {{chunk_text}}",
    purpose: "quality",
    created_at: new Date(),
  };
}

function makeClassification(
  overrides?: Partial<QualityClassificationRow>,
): QualityClassificationRow {
  return {
    id: "qc-1",
    chunk_id: "chunk-1",
    document_id: "doc-1",
    label: "high",
    confidence: 0.9,
    reasoning: "well written",
    prompt_id: "prompt-1",
    prompt_version: 1,
    model: "fake",
    provider: "fake",
    input_hash: "h",
    created_at: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides?: {
  chunk?: DocumentChunkRow | undefined;
  prompt?: PromptVersion | undefined;
  executorContent?: string;
  executorError?: Error;
  classification?: QualityClassificationRow;
}) {
  const chunkRepo: ChunkRepository = {
    createBatch: vi.fn(),
    getById: vi.fn(),
    getByDocumentId: vi.fn(),
    getBySectionId: vi.fn(),
    getByDocumentIdOrdered: vi.fn().mockImplementation(async () =>
      overrides && "chunk" in overrides && overrides.chunk ? [overrides.chunk] : [],
    ),
    deleteByDocumentId: vi.fn(),
  };

  const qualityRepo: QualityRepository = {
    replaceForChunk: vi.fn().mockResolvedValue(overrides?.classification ?? makeClassification()),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn(),
    deleteByChunkId: vi.fn(),
  };

  const promptRepo: PromptRepository = {
    create: vi.fn(),
    getById: vi.fn(),
    getByNameAndVersion: vi.fn(),
    getLatestVersion: vi.fn().mockImplementation(async () =>
      overrides && "prompt" in overrides ? overrides.prompt : makePrompt(),
    ),
    createNewVersion: vi.fn(),
    listByName: vi.fn(),
  };

  const promptExecutor: PromptExecutionService = {
    execute: overrides?.executorError
      ? vi.fn().mockRejectedValue(overrides.executorError)
      : vi.fn().mockResolvedValue({
          content:
            overrides?.executorContent ??
            '{"label": "high", "confidence": 0.9, "reasoning": "well written"}',
          promptId: "prompt-1",
          promptVersion: 1,
          model: "fake",
          provider: "fake",
          inputHash: "h",
          createdAt: new Date().toISOString(),
        }),
  };

  const provider: AiProvider = {
    name: "fake",
    generateText: vi.fn(),
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

  const gate: EnrichmentGateService = {
    markEnrichmentDoneAndMaybeEnqueueCluster: vi.fn().mockResolvedValue(null),
  };

  const editionRepo: EditionRepository = {
    create: vi.fn(),
    getById: vi.fn(),
    getByDate: vi.fn(),
    getOrCreateForDate: vi.fn(),
    transition: vi.fn(),
    isProcessingAllowed: vi.fn().mockResolvedValue(true),
    assertProcessingAllowed: vi.fn(),
  };

  return { chunkRepo, qualityRepo, promptRepo, promptExecutor, provider, provenanceRepo, gate, editionRepo };
}

describe("ClassifyQualityWorker", () => {
  it("supports classify_quality job type", () => {
    const deps = makeDeps();
    const worker = createClassifyQualityWorker(deps);
    expect(worker.supports("classify_quality")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("classifies quality and records provenance", async () => {
    const deps = makeDeps({ chunk: makeChunk() });
    const worker = createClassifyQualityWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptRepo.getLatestVersion).toHaveBeenCalledWith("quality");
    expect(deps.qualityRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkId: "chunk-1",
        label: "high",
        confidence: 0.9,
        reasoning: "well written",
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "chunk",
        sourceId: "chunk-1",
        targetType: "quality_classification",
        targetId: "qc-1",
        relation: "classified_as",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("accepts null reasoning", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorContent: '{"label": "low", "confidence": 0.5, "reasoning": null}',
    });
    const worker = createClassifyQualityWorker(deps);

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.qualityRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: null }),
    );
  });

  it("skips when chunk is not found for the document", async () => {
    const deps = makeDeps({ chunk: undefined });
    const worker = createClassifyQualityWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when quality prompt is not seeded", async () => {
    const deps = makeDeps({ chunk: makeChunk(), prompt: undefined });
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/no registered version/i);
  });

  it("throws when AI returns non-JSON", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorContent: "garbage" });
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws when JSON missing required fields", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorContent: '{"label": "high"}' });
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("throws when confidence out of range", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorContent: '{"label": "high", "confidence": 1.5, "reasoning": null}',
    });
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("propagates prompt executor errors", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorError: new Error("boom") });
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createClassifyQualityWorker(deps);

    await expect(
      worker.execute(makeJob({ target: null }), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/invalid target/i);
  });

  it("skips when the edition is not in a mutable state (state guard)", async () => {
    const deps = makeDeps();
    (deps.editionRepo.isProcessingAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const worker = createClassifyQualityWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(outcome).toEqual({});
    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(deps.qualityRepo.replaceForChunk).not.toHaveBeenCalled();
    expect(deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster).not.toHaveBeenCalled();
  });
});
