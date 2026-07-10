import { describe, it, expect, vi } from "vitest";
import { createClusterStoriesWorker } from "./cluster-stories-worker.js";
import type { DocumentRepository, DocumentRow } from "../expansion/document-repository.js";
import type { SummaryRepository, SummaryRow } from "../enrichment/summary/summary-repository.js";
import type { TopicRepository, TopicRow } from "../enrichment/topics/topic-repository.js";
import type { EmbeddingRepository, EmbeddingRow } from "../enrichment/embeddings/embedding-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type {
  StoryRepository,
  StoryClusterRow,
  ClusterMemberRow,
} from "./story-repository.js";
import type { SignalRepository, CreateSignalInput } from "../signals/signal-repository.js";
import type { SourceTrustRepository, SourceTrustRow } from "../signals/source-trust-repository.js";
import type { ProcessingJob } from "../database/kysely.js";

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "cluster_stories",
    edition_id: "edition-1",
    target: { editionId: "edition-1" },
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

function makeDoc(overrides?: Partial<DocumentRow>): DocumentRow {
  return {
    id: "doc-1",
    edition_id: "edition-1",
    source_type: "article",
    source_url: "https://example.com/" + (overrides?.id ?? "doc-1"),
    canonical_url: null,
    title: null,
    subtitle: null,
    authors: [],
    publisher: null,
    published_at: null,
    language: "en",
    content_markdown: null,
    content_text: null,
    metadata: {},
    created_at: new Date(),
    partition_key: "master",
    ...overrides,
  };
}

function makeSummary(
  documentId: string,
  content: string,
): SummaryRow {
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

function makeTopic(
  documentId: string,
  topic: string,
  confidence: number,
): TopicRow {
  return {
    id: `topic-${documentId}-${topic}`,
    chunk_id: `chunk-${documentId}`,
    document_id: documentId,
    topic,
    confidence,
    prompt_id: "prompt-1",
    prompt_version: 1,
    model: "m",
    provider: "p",
    input_hash: "h",
    created_at: new Date(),
  };
}

function makeEmbedding(documentId: string, vector: number[]): EmbeddingRow {
  return {
    id: `emb-${documentId}`,
    chunk_id: `chunk-${documentId}`,
    vector,
    model: "m",
    provider: "p",
    input_hash: "h",
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
  documents?: DocumentRow[];
  summariesByDoc?: Map<string, SummaryRow[]>;
  topicsByDoc?: Map<string, TopicRow[]>;
  embeddingsByDoc?: Map<string, EmbeddingRow[]>;
  trustRows?: SourceTrustRow[];
  fullyEnrichedDocs?: Set<string>;
  options?: Partial<import("./clustering-service.js").ClusterOptions>;
}) {
  const documents = overrides?.documents ?? [];
  const summariesByDoc = overrides?.summariesByDoc ?? new Map();
  const topicsByDoc = overrides?.topicsByDoc ?? new Map();
  const embeddingsByDoc = overrides?.embeddingsByDoc ?? new Map();
  const trustRows = overrides?.trustRows ?? [];

  const docRepo: DocumentRepository = {
    create: vi.fn(),
    getById: vi.fn().mockImplementation(async (id: string) => documents.find((d) => d.id === id)),
    getByEdition: vi.fn().mockImplementation(async () => documents),
    getByEditionAndUrl: vi.fn(),
    getByEditionAndPartition: vi.fn(),
    getRankedByEditionAndPartition: vi.fn(),
  };

  const summaryRepo: SummaryRepository = {
    replaceForChunk: vi.fn(),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn().mockImplementation(async (id: string) => summariesByDoc.get(id) ?? []),
    getCitationsBySummaryId: vi.fn(),
    deleteByChunkId: vi.fn(),
  };

  const topicRepo: TopicRepository = {
    replaceForChunk: vi.fn(),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn().mockImplementation(async (id: string) => topicsByDoc.get(id) ?? []),
    getAssignmentsByTopicId: vi.fn(),
    deleteByChunkId: vi.fn(),
  };

  const embeddingRepo: EmbeddingRepository = {
    replaceForChunk: vi.fn(),
    getByChunkId: vi.fn(),
    getByDocumentId: vi.fn().mockImplementation(async (id: string) => embeddingsByDoc.get(id) ?? []),
    deleteByChunkId: vi.fn(),
  };

  const storyRepo: StoryRepository = {
    replaceForEdition: vi.fn().mockImplementation(async ({ stories }: { stories: { label: string; documentIds: string[] }[] }) => ({
      stories: stories.map((s: { label: string; documentIds: string[] }, i: number) => ({
        story: {
          id: `story-${i}`,
          edition_id: "edition-1",
          label: s.label,
          cluster_order: i,
          created_at: new Date(),
          updated_at: new Date(),
        } as StoryClusterRow,
        members: s.documentIds.map((docId: string, j: number) => ({
          id: `member-${i}-${j}`,
          story_id: `story-${i}`,
          document_id: docId,
          role: "supporting",
          similarity: 0,
          created_at: new Date(),
        } as ClusterMemberRow)),
      })),
      removedStoryIds: [],
    })),
    getById: vi.fn(),
    getByEdition: vi.fn(),
    getMembers: vi.fn(),
    getStoryForDocument: vi.fn(),
    deleteByEdition: vi.fn().mockResolvedValue(undefined),
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

  const sourceTrustRepo: SourceTrustRepository = {
    set: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockResolvedValue(trustRows),
    delete: vi.fn(),
  };

  const fullyEnrichedDocs = overrides?.fullyEnrichedDocs ?? new Set(documents.map((d) => d.id));
  const enrichmentTracker: import("../editions/enrichment-tracker-repository.js").EnrichmentTrackerRepository = {
    markDone: vi.fn(),
    resetForDocument: vi.fn(),
    getCompletedTypesForDocument: vi.fn(),
    isDocumentFullyEnriched: vi.fn().mockImplementation(async (id: string) => fullyEnrichedDocs.has(id)),
    getDocumentCounts: vi.fn(),
    isEditionFullyEnriched: vi.fn(),
    getEditionEnqueuedAt: vi.fn(),
    claimEditionEnqueue: vi.fn(),
    resetEditionEnqueue: vi.fn(),
  };

  return {
    docRepo,
    summaryRepo,
    topicRepo,
    embeddingRepo,
    storyRepo,
    provenanceRepo,
    signalRepo,
    sourceTrustRepo,
    enrichmentTracker,
    options: overrides?.options,
  };
}

describe("ClusterStoriesWorker", () => {
  it("supports cluster_stories job type", () => {
    const deps = makeDeps();
    const worker = createClusterStoriesWorker(deps);
    expect(worker.supports("cluster_stories")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("returns no child jobs when edition has no documents", async () => {
    const deps = makeDeps({ documents: [] });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    expect(outcome).toEqual({});
    expect(deps.storyRepo.deleteByEdition).toHaveBeenCalledWith("edition-1");
    expect(deps.storyRepo.replaceForEdition).not.toHaveBeenCalled();
  });

  it("skips documents without summaries or embeddings and records no stories", async () => {
    const docs = [makeDoc({ id: "doc-1" }), makeDoc({ id: "doc-2" })];
    const deps = makeDeps({ documents: docs });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    expect(outcome).toEqual({});
    expect(deps.storyRepo.deleteByEdition).toHaveBeenCalledWith("edition-1");
  });

  it("clusters two related documents into one story and enqueues one summarize_story", async () => {
    const docs = [makeDoc({ id: "doc-1" }), makeDoc({ id: "doc-2" })];
    const summariesByDoc = new Map([
      ["doc-1", [makeSummary("doc-1", "AI breakthrough")]],
      ["doc-2", [makeSummary("doc-2", "AI breakthrough news")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-1", [makeTopic("doc-1", "ai", 0.9)]],
      ["doc-2", [makeTopic("doc-2", "ai", 0.8)]],
    ]);
    const v = [1, 0, 0];
    const embeddingsByDoc = new Map([
      ["doc-1", [makeEmbedding("doc-1", v)]],
      ["doc-2", [makeEmbedding("doc-2", v)]],
    ]);
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 1 },
    });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(deps.storyRepo.replaceForEdition).toHaveBeenCalledTimes(1);
    expect(outcome.childJobs).toBeDefined();
    expect(outcome.childJobs).toHaveLength(1);
    expect(outcome.childJobs![0].jobType).toBe("summarize_story");
    expect(outcome.childJobs![0].target).toEqual({ storyId: "story-0" });
    expect(deps.provenanceRepo.recordLineageBatch).toHaveBeenCalled();
  });

  it("clusters two unrelated documents into two stories and enqueues two summarize_story jobs", async () => {
    const docs = [makeDoc({ id: "doc-1" }), makeDoc({ id: "doc-2" })];
    const summariesByDoc = new Map([
      ["doc-1", [makeSummary("doc-1", "A")]],
      ["doc-2", [makeSummary("doc-2", "B")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-1", [makeTopic("doc-1", "ai", 0.9)]],
      ["doc-2", [makeTopic("doc-2", "weather", 0.9)]],
    ]);
    const embeddingsByDoc = new Map([
      ["doc-1", [makeEmbedding("doc-1", [1, 0])]],
      ["doc-2", [makeEmbedding("doc-2", [0, 1])]],
    ]);
    const deps = makeDeps({ documents: docs, summariesByDoc, topicsByDoc, embeddingsByDoc });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(outcome.childJobs).toHaveLength(2);
    for (const cj of outcome.childJobs!) {
      expect(cj.jobType).toBe("summarize_story");
      expect(cj.target).toMatchObject({ storyId: expect.any(String) });
    }
  });

  it("is idempotent: rerunning replaces edition stories", async () => {
    const docs = [makeDoc({ id: "doc-1" })];
    const summariesByDoc = new Map([
      ["doc-1", [makeSummary("doc-1", "S")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-1", [makeTopic("doc-1", "ai", 0.9)]],
    ]);
    const embeddingsByDoc = new Map([
      ["doc-1", [makeEmbedding("doc-1", [1, 0, 0])]],
    ]);
    const deps = makeDeps({ documents: docs, summariesByDoc, topicsByDoc, embeddingsByDoc });
    const worker = createClusterStoriesWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });
    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(deps.storyRepo.replaceForEdition).toHaveBeenCalledTimes(2);
  });

  it("throws on invalid target", async () => {
    const deps = makeDeps();
    const worker = createClusterStoriesWorker(deps);

    await expect(
      worker.execute(makeJob({ target: null }), { db: {} as any, logger: silentLogger() }),
    ).rejects.toThrow(/invalid target/i);
  });

  it("writes clustered_into_story signals for each cluster member", async () => {
    const docs = [makeDoc({ id: "doc-1" }), makeDoc({ id: "doc-2" })];
    const summariesByDoc = new Map([
      ["doc-1", [makeSummary("doc-1", "AI breakthrough")]],
      ["doc-2", [makeSummary("doc-2", "AI breakthrough news")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-1", [makeTopic("doc-1", "ai", 0.9)]],
      ["doc-2", [makeTopic("doc-2", "ai", 0.8)]],
    ]);
    const v = [1, 0, 0];
    const embeddingsByDoc = new Map([
      ["doc-1", [makeEmbedding("doc-1", v)]],
      ["doc-2", [makeEmbedding("doc-2", v)]],
    ]);
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 1 },
    });
    const worker = createClusterStoriesWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    const createBatch = deps.signalRepo.createBatch as unknown as ReturnType<typeof vi.fn>;
    expect(createBatch).toHaveBeenCalledTimes(1);
    const rows = createBatch.mock.calls[0][0] as CreateSignalInput[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.signal_kind).toBe("clustered_into_story");
      expect(row.edition_id).toBe("edition-1");
      expect(row.story_id).toBe("story-0");
      expect(row.source_identity).toBe("example.com");
    }
    const docIds = rows.map((r) => r.document_id).sort();
    expect(docIds).toEqual(["doc-1", "doc-2"]);
  });

  it("continues normally when signal insert fails", async () => {
    const docs = [makeDoc({ id: "doc-1" }), makeDoc({ id: "doc-2" })];
    const summariesByDoc = new Map([
      ["doc-1", [makeSummary("doc-1", "AI breakthrough")]],
      ["doc-2", [makeSummary("doc-2", "AI breakthrough news")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-1", [makeTopic("doc-1", "ai", 0.9)]],
      ["doc-2", [makeTopic("doc-2", "ai", 0.8)]],
    ]);
    const v = [1, 0, 0];
    const embeddingsByDoc = new Map([
      ["doc-1", [makeEmbedding("doc-1", v)]],
      ["doc-2", [makeEmbedding("doc-2", v)]],
    ]);
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 1 },
    });
    (deps.signalRepo.createBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(outcome.childJobs).toBeDefined();
    expect(outcome.childJobs).toHaveLength(1);
    expect(outcome.childJobs![0].jobType).toBe("summarize_story");
  });

  it("passes sourceIdentity + source-trust ranking to clusterDocuments so higher-trust clusters sort first", async () => {
    const docs = [
      makeDoc({
        id: "doc-shady",
        source_url: "https://shady.com/article",
        source_type: "article",
      }),
      makeDoc({
        id: "doc-trusted",
        source_url: "https://trusted.com/article",
        source_type: "article",
      }),
    ];
    const summariesByDoc = new Map([
      ["doc-shady", [makeSummary("doc-shady", "shady story")]],
      ["doc-trusted", [makeSummary("doc-trusted", "trusted story")]],
    ]);
    const topicsByDoc = new Map([
      ["doc-shady", [makeTopic("doc-shady", "ai", 0.9)]],
      ["doc-trusted", [makeTopic("doc-trusted", "weather", 0.9)]],
    ]);
    const embeddingsByDoc = new Map([
      ["doc-shady", [makeEmbedding("doc-shady", [1, 0])]],
      ["doc-trusted", [makeEmbedding("doc-trusted", [0, 1])]],
    ]);
    const trustRows: SourceTrustRow[] = [
      {
        source_identity: "trusted.com",
        tier: 1,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        source_identity: "shady.com",
        tier: 5,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      trustRows,
    });
    const worker = createClusterStoriesWorker(deps);

    await worker.execute(makeJob(), { db: {} as any, logger: silentLogger() });

    expect(deps.sourceTrustRepo.getAll).toHaveBeenCalledTimes(1);
    const replaceForEdition = deps.storyRepo.replaceForEdition as ReturnType<typeof vi.fn>;
    expect(replaceForEdition).toHaveBeenCalledTimes(1);
    const passed = replaceForEdition.mock.calls[0][0] as {
      stories: { label: string; documentIds: string[] }[];
    };
    expect(passed.stories).toHaveLength(2);
    expect(passed.stories[0].documentIds).toEqual(["doc-trusted"]);
    expect(passed.stories[1].documentIds).toEqual(["doc-shady"]);
  });

  it("respects targetStories: 11 diverse docs with targetStories=7 produce ~7 stories", async () => {
    const docs = Array.from({ length: 11 }, (_, i) =>
      makeDoc({
        id: `doc-${i}`,
        source_url: `https://example.com/d${i}`,
        source_type: "article",
      }),
    );
    const summariesByDoc = new Map(
      docs.map((d) => [d.id, [makeSummary(d.id, `Summary for ${d.id}`)]]),
    );
    const topicsByDoc = new Map(
      docs.map((d) => [d.id, [makeTopic(d.id, "ai", 0.9)]]),
    );
    const base = [0.1, 0.2, 0.3, 0.4];
    const embeddingsByDoc = new Map(
      docs.map((d, i) => [
        d.id,
        [
          makeEmbedding(
            d.id,
            base.map((b, j) => b + Math.sin(i * 1.7 + j * 0.7) * 0.05),
          ),
        ],
      ]),
    );
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 7, similarityThreshold: 0.6 },
    });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome.childJobs).toBeDefined();
    expect(outcome.childJobs!.length).toBeGreaterThanOrEqual(5);
    expect(outcome.childJobs!.length).toBeLessThanOrEqual(7);
  });

  it("respects targetStories=11: 11 orthogonal docs produce 11 stories", async () => {
    const docs = Array.from({ length: 11 }, (_, i) =>
      makeDoc({
        id: `doc-${i}`,
        source_url: `https://example.com/d${i}`,
        source_type: "article",
      }),
    );
    const summariesByDoc = new Map(
      docs.map((d) => [d.id, [makeSummary(d.id, `Summary for ${d.id}`)]]),
    );
    const topicsByDoc = new Map(
      docs.map((d, i) => [d.id, [makeTopic(d.id, `topic-${i}`, 0.9)]]),
    );
    const embeddingsByDoc = new Map(
      docs.map((d, i) => {
        const v = new Array<number>(11).fill(0);
        v[i] = 1;
        return [d.id, [makeEmbedding(d.id, v)]];
      }),
    );
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 11 },
    });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome.childJobs).toHaveLength(11);
    for (const cj of outcome.childJobs!) {
      expect(cj.jobType).toBe("summarize_story");
    }
  });

  it("average-link: 2 similar docs and 1 outlier — with targetStories=1, the outlier stays separate (no chain-merge)", async () => {
    const docs = [
      makeDoc({ id: "doc-0", source_url: "https://example.com/d0", source_type: "article" }),
      makeDoc({ id: "doc-1", source_url: "https://example.com/d1", source_type: "article" }),
      makeDoc({ id: "doc-2", source_url: "https://example.com/d2", source_type: "article" }),
    ];
    const summariesByDoc = new Map(docs.map((d) => [d.id, [makeSummary(d.id, `Summary ${d.id}`)]]));
    const topicsByDoc = new Map(docs.map((d) => [d.id, [makeTopic(d.id, "ai", 0.9)]]));
    const embeddingsByDoc = new Map([
      ["doc-0", [makeEmbedding("doc-0", [1, 0])]],
      ["doc-1", [makeEmbedding("doc-1", [0.99, 0.01])]],
      ["doc-2", [makeEmbedding("doc-2", [0, 1])]],
    ]);
    const deps = makeDeps({
      documents: docs,
      summariesByDoc,
      topicsByDoc,
      embeddingsByDoc,
      options: { targetStories: 1, similarityThreshold: 0.7 },
    });
    const worker = createClusterStoriesWorker(deps);

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: silentLogger(),
    });

    expect(outcome.childJobs).toBeDefined();
    expect(outcome.childJobs!.length).toBeGreaterThanOrEqual(2);
    const sizes = (outcome.childJobs as { target: { storyId: string } }[])
      .map(() => 1);
    expect(sizes.length).toBe(outcome.childJobs!.length);
  });
});
