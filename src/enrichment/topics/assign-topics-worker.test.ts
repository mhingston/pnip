import { describe, it, expect, vi } from "vitest";
import { createAssignTopicsWorker } from "./assign-topics-worker.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { TopicRepository, TopicRow, TopicAssignmentRow } from "./topic-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "assign_topics",
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
    content_text: "AI is transforming industries.",
    token_count: 5,
    start_offset: 0,
    end_offset: 30,
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
    name: "topics",
    version: 1,
    template: "Topics: {{chunk_text}}",
    purpose: "topic",
    created_at: new Date(),
  };
}

function makeTopic(overrides?: Partial<TopicRow>): TopicRow {
  return {
    id: "topic-1",
    chunk_id: "chunk-1",
    document_id: "doc-1",
    topic: "artificial intelligence",
    confidence: 0.9,
    prompt_id: "prompt-1",
    prompt_version: 1,
    model: "fake",
    provider: "fake",
    input_hash: "h",
    created_at: new Date(),
    ...overrides,
  };
}

function makeAssignment(overrides?: Partial<TopicAssignmentRow>): TopicAssignmentRow {
  return {
    id: "as-1",
    topic_id: "topic-1",
    chunk_id: "chunk-1",
    relevance: 0.85,
    created_at: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides?: {
  chunk?: DocumentChunkRow | undefined;
  prompt?: PromptVersion | undefined;
  executorContent?: string;
  executorError?: Error;
  topics?: TopicRow[];
  assignments?: TopicAssignmentRow[];
}) {
  const chunkRepo: ChunkRepository = {
    createBatch: vi.fn(),
    getByDocumentId: vi.fn(),
    getBySectionId: vi.fn(),
    getByDocumentIdOrdered: vi.fn().mockImplementation(async () =>
      overrides && "chunk" in overrides && overrides.chunk ? [overrides.chunk] : [],
    ),
    deleteByDocumentId: vi.fn(),
  };

  const topicRepo: TopicRepository = {
    replaceForChunk: vi.fn().mockResolvedValue({
      topics: overrides?.topics ?? [makeTopic()],
      assignments: overrides?.assignments ?? [makeAssignment()],
    }),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn(),
    getAssignmentsByTopicId: vi.fn(),
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
          content: overrides?.executorContent ?? '{"topics": [{"topic": "artificial intelligence", "confidence": 0.9, "relevance": 0.85}]}',
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

  return { chunkRepo, topicRepo, promptRepo, promptExecutor, provider, provenanceRepo, gate, editionRepo };
}

describe("AssignTopicsWorker", () => {
  it("supports assign_topics job type", () => {
    const deps = makeDeps();
    const worker = createAssignTopicsWorker(deps);
    expect(worker.supports("assign_topics")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("assigns topics and records provenance for topics + assignments", async () => {
    const deps = makeDeps({ chunk: makeChunk() });
    const worker = createAssignTopicsWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptRepo.getLatestVersion).toHaveBeenCalledWith("topics");
    expect(deps.topicRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkId: "chunk-1",
        topics: [
          { topic: "artificial intelligence", confidence: 0.9, relevance: 0.85 },
        ],
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "chunk",
        sourceId: "chunk-1",
        targetType: "topic",
        targetId: "topic-1",
        relation: "assigned_to",
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "topic",
        sourceId: "topic-1",
        targetType: "chunk",
        targetId: "chunk-1",
        relation: "covers",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("skips when chunk is not found for the document", async () => {
    const deps = makeDeps({ chunk: undefined });
    const worker = createAssignTopicsWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when topics prompt is not seeded", async () => {
    const deps = makeDeps({ chunk: makeChunk(), prompt: undefined });
    const worker = createAssignTopicsWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/no registered version/i);
  });

  it("throws when AI returns non-JSON", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorContent: "garbage" });
    const worker = createAssignTopicsWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws when JSON missing topics field", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorContent: '{"other": []}' });
    const worker = createAssignTopicsWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing required field/);
  });

  it("throws when topic entry has out-of-range confidence", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorContent: '{"topics": [{"topic": "ai", "confidence": 1.5, "relevance": 0.5}]}',
    });
    const worker = createAssignTopicsWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/confidence\/relevance/);
  });

  it("propagates prompt executor errors", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorError: new Error("boom") });
    const worker = createAssignTopicsWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createAssignTopicsWorker(deps);

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
    const worker = createAssignTopicsWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(outcome).toEqual({});
    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(deps.topicRepo.replaceForChunk).not.toHaveBeenCalled();
    expect(deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster).not.toHaveBeenCalled();
  });
});
