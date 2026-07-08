import { describe, it, expect, vi } from "vitest";
import { createSummarizeStoryWorker } from "./summarize-story-worker.js";
import type { StoryRepository, StoryClusterRow } from "./story-repository.js";
import type {
  StorySummaryRepository,
  StorySummaryRow,
  StorySummaryCitationRow,
} from "./story-summary-repository.js";
import type { DocumentRepository, DocumentRow } from "../expansion/document-repository.js";
import type { ChunkRepository, DocumentChunkRow } from "../chunking/chunk-repository.js";
import type { SummaryRepository, SummaryRow } from "../enrichment/summary/summary-repository.js";
import type { PromptRepository } from "../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../ai/prompt-execution.js";
import type { AiProvider } from "../ai/provider.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { SignalRepository, CreateSignalInput } from "../signals/signal-repository.js";
import type { ProcessingJob, PromptVersion } from "../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "summarize_story",
    edition_id: "edition-1",
    target: { storyId: "story-1" },
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

function makeStory(overrides?: Partial<StoryClusterRow>): StoryClusterRow {
  return {
    id: "story-1",
    edition_id: "edition-1",
    label: "ai-breakthrough",
    cluster_order: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeChunk(overrides?: Partial<DocumentChunkRow>): DocumentChunkRow {
  return {
    id: "chunk-1",
    document_id: "doc-1",
    section_id: "sec-1",
    chunk_sequence: 0,
    content_text: "Federal Reserve raised rates.",
    token_count: 4,
    start_offset: 0,
    end_offset: 28,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeDoc(overrides?: Partial<DocumentRow>): DocumentRow {
  return {
    id: "doc-1",
    edition_id: "edition-1",
    source_type: "article",
    source_url: "https://example.com/" + (overrides?.id ?? "doc-1"),
    canonical_url: null,
    title: "Fed raises rates",
    subtitle: null,
    authors: [],
    publisher: null,
    published_at: null,
    language: "en",
    content_markdown: null,
    content_text: null,
    metadata: {},
    created_at: new Date(),
    ...overrides,
  };
}

function makeSummary(documentId: string, content: string): SummaryRow {
  return {
    id: `summary-${documentId}`,
    chunk_id: `chunk-${documentId}`,
    document_id: documentId,
    content,
    prompt_id: "prompt-1",
    prompt_version: 1,
    model: "m",
    provider: "p",
    input_hash: "h",
    created_at: new Date(),
  };
}

function makePromptVersion(): PromptVersion {
  return {
    id: "prompt-1",
    name: "story_summary",
    version: 1,
    template: "{{story_label}} {{document_summaries}} {{source_chunks}}",
    purpose: "story summary",
    created_at: new Date(),
  };
}

function silentLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeDeps(overrides?: {
  story?: StoryClusterRow | undefined;
  members?: { document_id: string }[];
  documents?: Map<string, DocumentRow>;
  chunks?: Map<string, DocumentChunkRow[]>;
  summaries?: Map<string, SummaryRow[]>;
  prompt?: PromptVersion | undefined;
  executorResult?: { content: string } & Record<string, unknown>;
  executorError?: Error;
  summaryResult?: { summary: StorySummaryRow; citations: StorySummaryCitationRow[] };
}) {
  const storyRepo: StoryRepository = {
    replaceForEdition: vi.fn(),
    getById: vi.fn().mockImplementation(async (id: string) =>
      overrides && "story" in overrides ? overrides.story : makeStory({ id }),
    ),
    getByEdition: vi.fn(),
    getMembers: vi.fn().mockImplementation(async () => overrides?.members ?? []),
    getStoryForDocument: vi.fn(),
    deleteByEdition: vi.fn(),
  };

  const storySummaryRepo: StorySummaryRepository = {
    replaceForStory: vi.fn().mockImplementation(async (input: { storyId: string; content: string; promptId: string; promptVersion: number; model: string; provider: string; inputHash: string; claims: { text: string; chunkId: string }[] }) => {
      if (overrides?.summaryResult) return overrides.summaryResult;
      const summary: StorySummaryRow = {
        id: "ss-1",
        story_id: input.storyId,
        content: input.content,
        prompt_id: input.promptId,
        prompt_version: input.promptVersion,
        model: input.model,
        provider: input.provider,
        input_hash: input.inputHash,
        created_at: new Date(),
      };
      const citations: StorySummaryCitationRow[] = input.claims.map((c: { text: string; chunkId: string }, i: number) => ({
        id: `cit-${i}`,
        story_summary_id: "ss-1",
        chunk_id: c.chunkId,
        claim_text: c.text,
        claim_order: i,
        created_at: new Date(),
      }));
      return { summary, citations };
    }),
    getByStoryId: vi.fn(),
    getCitationsBySummaryId: vi.fn(),
    deleteByStoryId: vi.fn(),
  };

  const docRepo: DocumentRepository = {
    create: vi.fn(),
    getById: vi.fn().mockImplementation(async (id: string) => overrides?.documents?.get(id)),
    getByEdition: vi.fn(),
    getByEditionAndUrl: vi.fn(),
  };

  const chunkRepo: ChunkRepository = {
    createBatch: vi.fn(),
    getById: vi.fn(),
    getByDocumentId: vi.fn().mockImplementation(async (id: string) => overrides?.chunks?.get(id) ?? []),
    getBySectionId: vi.fn(),
    getByDocumentIdOrdered: vi.fn().mockImplementation(async (id: string) => overrides?.chunks?.get(id) ?? []),
    deleteByDocumentId: vi.fn(),
  };

  const summaryRepo: SummaryRepository = {
    replaceForChunk: vi.fn(),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn().mockImplementation(async (id: string) => overrides?.summaries?.get(id) ?? []),
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
      : vi.fn().mockResolvedValue({
          content:
            overrides?.executorResult?.content ??
            '{"summary": "Story summary.", "claims": ["The Fed raised rates [chunk 1]."]}',
          promptId: "prompt-1",
          promptVersion: 1,
          model: "m",
          provider: "p",
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
    recordLineageBatch: vi.fn().mockResolvedValue(undefined),
    getSources: vi.fn(),
    getConsumers: vi.fn(),
    resolveCitations: vi.fn(),
    resolveToDocuments: vi.fn(),
  };

  const signalRepo: SignalRepository = {
    createBatch: vi.fn().mockResolvedValue([]),
    getByEdition: vi.fn(),
    getByEditionAndKind: vi.fn(),
    countByEditionAndKind: vi.fn(),
    getBySourceIdentity: vi.fn(),
    getFeedbackSummary: vi.fn(),
    getSourceIdentityStats: vi.fn(),
  };

  return {
    storyRepo,
    storySummaryRepo,
    docRepo,
    chunkRepo,
    summaryRepo,
    promptRepo,
    promptExecutor,
    provider,
    provenanceRepo,
    signalRepo,
  };
}

describe("SummarizeStoryWorker", () => {
  it("supports summarize_story job type", () => {
    const deps = makeDeps();
    const worker = createSummarizeStoryWorker(deps);
    expect(worker.supports("summarize_story")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("skips when story does not exist", async () => {
    const deps = makeDeps({ story: undefined });
    const worker = createSummarizeStoryWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    expect(outcome).toEqual({});
    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
  });

  it("skips when story has no members", async () => {
    const deps = makeDeps({ members: [] });
    const worker = createSummarizeStoryWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    expect(outcome).toEqual({});
    expect(deps.promptExecutor.execute).not.toHaveBeenCalled();
  });

  it("skips when there are no summaries or chunks", async () => {
    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: new Map([["doc-1", makeDoc()]]),
    });
    const worker = createSummarizeStoryWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    expect(outcome).toEqual({});
  });

  it("renders prompt, persists summary + citations, records lineage", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk({ id: "chunk-1" })]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "Fed raised rates.")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
    });
    const worker = createSummarizeStoryWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(deps.promptRepo.getLatestVersion).toHaveBeenCalledWith("story_summary");
    expect(deps.promptExecutor.execute).toHaveBeenCalledTimes(1);
    const callArg = (deps.promptExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.variables.story_label).toBe("ai-breakthrough");
    expect(callArg.variables.document_summaries).toContain("Fed raised rates.");
    expect(callArg.variables.source_chunks).toContain("[chunk 1 id=chunk-1]");

    expect(deps.storySummaryRepo.replaceForStory).toHaveBeenCalledTimes(1);
    const persistArg = (deps.storySummaryRepo.replaceForStory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArg.storyId).toBe("story-1");
    expect(persistArg.content).toBe("Story summary.");
    expect(persistArg.claims).toHaveLength(1);
    expect(persistArg.claims[0].chunkId).toBe("chunk-1");
    expect(persistArg.claims[0].text).toBe("The Fed raised rates .");

    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "story",
        sourceId: "story-1",
        targetType: "chunk",
        targetId: "chunk-1",
        relation: "cite",
      }),
    );
    expect(deps.provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "story",
        sourceId: "story-1",
        targetType: "story_summary",
        targetId: "ss-1",
        relation: "summarized_by",
      }),
    );
    expect(outcome).toEqual({});
  });

  it("falls back to a source chunk when claim has no chunk reference", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk({ id: "chunk-1" }), makeChunk({ id: "chunk-2", chunk_sequence: 1, content_text: "Other text.", start_offset: 29, end_offset: 40 })]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "S")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
      executorResult: {
        content: '{"summary": "S", "claims": ["No refs claim.", "Another no refs."]}',
      },
    });
    const worker = createSummarizeStoryWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    const persistArg = (deps.storySummaryRepo.replaceForStory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArg.claims[0].chunkId).toBe("chunk-1");
    expect(persistArg.claims[1].chunkId).toBe("chunk-2");
  });

  it("uses the referenced chunk for claims with chunk references", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([
      [
        "doc-1",
        [
          makeChunk({ id: "chunk-1" }),
          makeChunk({ id: "chunk-2", chunk_sequence: 1, content_text: "B", start_offset: 0, end_offset: 1 }),
          makeChunk({ id: "chunk-3", chunk_sequence: 2, content_text: "C", start_offset: 0, end_offset: 1 }),
        ],
      ],
    ]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "S")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
      executorResult: {
        content: '{"summary": "S", "claims": ["A [chunk 3]."]}',
      },
    });
    const worker = createSummarizeStoryWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    const persistArg = (deps.storySummaryRepo.replaceForStory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArg.claims[0].chunkId).toBe("chunk-3");
  });

  it("throws when story_summary prompt is not seeded", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk()]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "S")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
      prompt: undefined,
    });
    const worker = createSummarizeStoryWorker(deps);

    await expect(
      worker.execute(makeJob(), { db: {} as any, logger: silentLogger() }),
    ).rejects.toThrow(/no registered version/i);
  });

  it("throws when AI returns non-JSON", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk()]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "S")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
      executorResult: { content: "not json" },
    });
    const worker = createSummarizeStoryWorker(deps);

    await expect(
      worker.execute(makeJob(), { db: {} as any, logger: silentLogger() }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createSummarizeStoryWorker(deps);

    await expect(
      worker.execute(makeJob({ target: null }), { db: {} as any, logger: silentLogger() }),
    ).rejects.toThrow(/invalid target/i);
  });

  it("writes chunk_in_story signals for each cited chunk", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk({ id: "chunk-1" })]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "Fed raised rates.")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
    });
    const worker = createSummarizeStoryWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    const createBatch = deps.signalRepo.createBatch as unknown as ReturnType<typeof vi.fn>;
    expect(createBatch).toHaveBeenCalledTimes(1);
    const rows = createBatch.mock.calls[0][0] as CreateSignalInput[];
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_kind).toBe("chunk_in_story");
    expect(rows[0].edition_id).toBe("edition-1");
    expect(rows[0].story_id).toBe("story-1");
    expect(rows[0].chunk_id).toBe("chunk-1");
    expect(rows[0].source_identity).toBeNull();
  });

  it("continues normally when signal insert fails", async () => {
    const docs = new Map([["doc-1", makeDoc()]]);
    const chunks = new Map([["doc-1", [makeChunk({ id: "chunk-1" })]]]);
    const summaries = new Map([["doc-1", [makeSummary("doc-1", "Fed raised rates.")]]]);

    const deps = makeDeps({
      members: [{ document_id: "doc-1" }],
      documents: docs,
      chunks,
      summaries,
    });
    (deps.signalRepo.createBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const worker = createSummarizeStoryWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(outcome).toEqual({});
    expect(deps.storySummaryRepo.replaceForStory).toHaveBeenCalledTimes(1);
  });
});
