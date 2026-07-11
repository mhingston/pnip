import { describe, it, expect, vi } from "vitest";
import { createExtractEntitiesWorker } from "./extract-entities-worker.js";
import type { ChunkRepository, DocumentChunkRow } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { EntityRepository, EntityRow, EntityMentionRow } from "./entity-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "extract_entities",
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
    content_text: "Apple Inc. released a new iPhone.",
    token_count: 6,
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

function makePrompt(): PromptVersion {
  return {
    id: "prompt-1",
    name: "entities",
    version: 1,
    template: "Extract entities from: {{chunk_text}}",
    purpose: "extract entities",
    created_at: new Date(),
  };
}

function makeEntity(overrides?: Partial<EntityRow>): EntityRow {
  return {
    id: "ent-1",
    chunk_id: "chunk-1",
    document_id: "doc-1",
    name: "Apple Inc.",
    entity_type: "organization",
    prompt_id: "prompt-1",
    prompt_version: 1,
    model: "fake",
    provider: "fake",
    input_hash: "h",
    created_at: new Date(),
    ...overrides,
  };
}

function makeMention(overrides?: Partial<EntityMentionRow>): EntityMentionRow {
  return {
    id: "men-1",
    entity_id: "ent-1",
    chunk_id: "chunk-1",
    mention_text: "Apple",
    created_at: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides?: {
  chunk?: DocumentChunkRow | undefined;
  prompt?: PromptVersion | undefined;
  executorContent?: string;
  executorError?: Error;
  entities?: EntityRow[];
  mentions?: EntityMentionRow[];
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

  const entityRepo: EntityRepository = {
    replaceForChunk: vi.fn().mockResolvedValue({
      entities: overrides?.entities ?? [makeEntity()],
      mentions: overrides?.mentions ?? [makeMention()],
    }),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn(),
    getMentionsByEntityId: vi.fn(),
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
          content: overrides?.executorContent ?? '{"entities": [{"name": "Apple Inc.", "type": "organization", "mention": "Apple"}]}',
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

  return { chunkRepo, entityRepo, promptRepo, promptExecutor, provider, provenanceRepo, gate, editionRepo };
}

describe("ExtractEntitiesWorker", () => {
  it("supports extract_entities job type", () => {
    const deps = makeDeps();
    const worker = createExtractEntitiesWorker(deps);
    expect(worker.supports("extract_entities")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("extracts entities and records provenance for entities + mentions", async () => {
    const deps = makeDeps({ chunk: makeChunk() });
    const worker = createExtractEntitiesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptRepo.getLatestVersion).toHaveBeenCalledWith("entities");
    expect(deps.entityRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkId: "chunk-1",
        entities: [
          { name: "Apple Inc.", entityType: "organization", mentionText: "Apple" },
        ],
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "chunk",
        sourceId: "chunk-1",
        targetType: "entity",
        targetId: "ent-1",
        relation: "extracted_from",
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "entity",
        sourceId: "ent-1",
        targetType: "chunk",
        targetId: "chunk-1",
        relation: "mentioned_in",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("suppresses duplicate entities returned for the same chunk", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorContent:
        '{"entities": [' +
        '{"name":"Apple Inc.","type":"organization","mention":"Apple"},' +
        '{"name":"Apple Inc.","type":"organization","mention":"Apple Inc."}' +
        ']}' ,
    });
    const worker = createExtractEntitiesWorker(deps);

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.entityRepo.replaceForChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        entities: [
          { name: "Apple Inc.", entityType: "organization", mentionText: "Apple" },
        ],
      }),
    );
  });

  it("skips when chunk is not found for the document", async () => {
    const deps = makeDeps({ chunk: undefined });
    const worker = createExtractEntitiesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(deps.entityRepo.replaceForChunk).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when entities prompt is not seeded", async () => {
    const deps = makeDeps({ chunk: makeChunk(), prompt: undefined });
    const worker = createExtractEntitiesWorker(deps);

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
      executorContent: "not json",
    });
    const worker = createExtractEntitiesWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws when JSON missing entities field", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorContent: '{"other": []}' });
    const worker = createExtractEntitiesWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing required field/);
  });

  it("throws when entity entry missing name/type/mention strings", async () => {
    const deps = makeDeps({
      chunk: makeChunk(),
      executorContent: '{"entities": [{"name": "Apple", "type": "org"}]}',
    });
    const worker = createExtractEntitiesWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/missing name\/type\/mention/);
  });

  it("propagates prompt executor errors", async () => {
    const deps = makeDeps({ chunk: makeChunk(), executorError: new Error("boom") });
    const worker = createExtractEntitiesWorker(deps);

    await expect(
      worker.execute(makeJob(), {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createExtractEntitiesWorker(deps);

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
    const worker = createExtractEntitiesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(outcome).toEqual({});
    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
    expect(deps.entityRepo.replaceForChunk).not.toHaveBeenCalled();
    expect(deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster).not.toHaveBeenCalled();
  });
});
