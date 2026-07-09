import { describe, it, expect, vi } from "vitest";
import {
  FEEDBACK_HELP,
  parseFeedbackFlags,
  runFeedbackCommand,
  type FeedbackCommandDeps,
} from "./feedback.js";
import { deriveSourceIdentity } from "../signals/source-identity.js";
import type { SignalRepository, SignalRow } from "../signals/signal-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { StoryRepository, StoryClusterRow } from "../clustering/story-repository.js";
import type { DocumentRepository, DocumentRow } from "../expansion/document-repository.js";
import type { ChunkRepository, DocumentChunkRow } from "../chunking/chunk-repository.js";
import type { Edition } from "../database/kysely.js";

const EID = "11111111-2222-3333-4444-555555555555";
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function fakeSignalRow(overrides?: Partial<SignalRow>): SignalRow {
  return {
    id: overrides?.id ?? "sig-1",
    signal_kind: overrides?.signal_kind ?? "story_up",
    edition_id: overrides?.edition_id ?? "ed-1",
    story_id: overrides?.story_id ?? null,
    chunk_id: overrides?.chunk_id ?? null,
    document_id: overrides?.document_id ?? null,
    source_url: overrides?.source_url ?? null,
    source_identity: overrides?.source_identity ?? null,
    payload: overrides?.payload ?? {},
    created_at: new Date(),
  };
}

function fakeEdition(overrides?: Partial<Edition>): Edition {
  return {
    id: overrides?.id ?? "ed-1",
    publication_date: overrides?.publication_date ?? new Date("2026-07-08"),
    status: overrides?.status ?? "ready",
    created_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    partition_key: overrides?.partition_key ?? "master",
  };
}

function fakeStory(overrides?: Partial<StoryClusterRow>): StoryClusterRow {
  return {
    id: overrides?.id ?? "story-1",
    edition_id: overrides?.edition_id ?? "ed-1",
    label: overrides?.label ?? "Story",
    cluster_order: overrides?.cluster_order ?? 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function fakeDocument(overrides?: Partial<DocumentRow>): DocumentRow {
  return {
    id: overrides?.id ?? "doc-1",
    edition_id: overrides?.edition_id ?? "ed-1",
    source_type: overrides?.source_type ?? "article",
    source_url: overrides?.source_url ?? "https://example.com/article",
    canonical_url: null,
    title: null,
    subtitle: null,
    authors: null,
    publisher: overrides?.publisher ?? null,
    published_at: null,
    language: "en",
    content_markdown: null,
    content_text: null,
    metadata: overrides?.metadata ?? null,
    created_at: new Date(),
    partition_key: overrides?.partition_key ?? "master",
  };
}

function fakeChunk(overrides?: Partial<DocumentChunkRow>): DocumentChunkRow {
  return {
    id: overrides?.id ?? "chunk-1",
    document_id: overrides?.document_id ?? "doc-1",
    section_id: "sec-1",
    chunk_sequence: 0,
    content_text: "hello",
    token_count: 5,
    start_offset: 0,
    end_offset: 5,
    paragraph_start: 0,
    paragraph_end: 0,
    timestamp_start: null,
    timestamp_end: null,
    created_at: new Date(),
  };
}

function makeFakeSignalRepo(opts: { rows?: SignalRow[]; error?: Error } = {}): SignalRepository {
  return {
    createBatch: opts.error
      ? vi.fn().mockRejectedValue(opts.error)
      : vi.fn().mockResolvedValue(opts.rows ?? [fakeSignalRow()]),
    getByEdition: vi.fn().mockResolvedValue([]),
    getByEditionAndKind: vi.fn().mockResolvedValue([]),
    countByEditionAndKind: vi.fn().mockResolvedValue(0),
    getBySourceIdentity: vi.fn().mockResolvedValue([]),
    getFeedbackSummary: vi.fn().mockResolvedValue({
      signalCounts: {},
      totalSignals: 0,
      topMutedSources: [],
      topVotedStories: [],
      topStarredChunks: [],
      sourceIdentityCount: 0,
      storyVoteCount: 0,
    }),
    getSourceIdentityStats: vi.fn().mockResolvedValue({
      source_identity: "",
      mute_count: 0,
      chunk_star_count: 0,
      cited_in_story_count: 0,
      total_signals: 0,
    }),
  };
}

function makeFakeEditionRepo(opts: {
  byId?: Edition | undefined;
  byDate?: Edition | undefined;
  error?: Error;
} = {}): EditionRepository {
  return {
    create: vi.fn().mockResolvedValue(fakeEdition()),
    getById: opts.error
      ? vi.fn().mockRejectedValue(opts.error)
      : vi.fn().mockResolvedValue(opts.byId),
    getByDate: vi.fn().mockResolvedValue(opts.byDate),
    getOrCreateForDate: vi.fn().mockResolvedValue(fakeEdition()),
    transition: vi.fn().mockResolvedValue(fakeEdition()),
    isProcessingAllowed: vi.fn().mockResolvedValue(true),
    assertProcessingAllowed: vi.fn().mockResolvedValue(fakeEdition()),
  };
}

function makeFakeStoryRepo(opts: { byId?: StoryClusterRow | undefined } = {}): StoryRepository {
  return {
    replaceForEdition: vi.fn(),
    getById: vi.fn().mockResolvedValue(opts.byId),
    getByEdition: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
    getStoryForDocument: vi.fn().mockResolvedValue(undefined),
    deleteByEdition: vi.fn(),
  };
}

function makeFakeDocRepo(opts: {
  byId?: DocumentRow | undefined;
  byEditionAndUrl?: DocumentRow | undefined;
} = {}): DocumentRepository {
  return {
    create: vi.fn().mockResolvedValue(fakeDocument()),
    getById: vi.fn().mockResolvedValue(opts.byId),
    getByEdition: vi.fn().mockResolvedValue([]),
    getByEditionAndUrl: vi.fn().mockResolvedValue(opts.byEditionAndUrl),
    getByEditionAndPartition: vi.fn().mockResolvedValue([]),
  };
}

function makeFakeChunkRepo(opts: { byId?: DocumentChunkRow | undefined } = {}): ChunkRepository {
  return {
    createBatch: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(opts.byId),
    getByDocumentId: vi.fn().mockResolvedValue([]),
    getBySectionId: vi.fn().mockResolvedValue([]),
    getByDocumentIdOrdered: vi.fn().mockResolvedValue([]),
    deleteByDocumentId: vi.fn(),
  };
}

function makeDeps(overrides: {
  signalRepo?: SignalRepository;
  editionRepo?: EditionRepository;
  storyRepo?: StoryRepository;
  docRepo?: DocumentRepository;
  chunkRepo?: ChunkRepository;
  args?: string[];
  log?: (m: string) => void;
} = {}): FeedbackCommandDeps {
  return {
    signalRepo: overrides.signalRepo ?? makeFakeSignalRepo(),
    editionRepo: overrides.editionRepo ?? makeFakeEditionRepo(),
    storyRepo: overrides.storyRepo ?? makeFakeStoryRepo(),
    docRepo: overrides.docRepo ?? makeFakeDocRepo(),
    chunkRepo: overrides.chunkRepo ?? makeFakeChunkRepo(),
    args: overrides.args ?? [],
    log: overrides.log,
  };
}

describe("parseFeedbackFlags", () => {
  it("rate: parses edition_id, story_id, --up (default)", () => {
    const r = parseFeedbackFlags({ args: ["rate", EID, SID] });
    expect(r.errors).toEqual([]);
    expect(r.subcommand).toBe("rate");
    expect(r.rate?.editionId).toBe(EID);
    expect(r.rate?.storyId).toBe(SID);
    expect(r.rate?.direction).toBe("up");
  });

  it("rate: parses --down", () => {
    const r = parseFeedbackFlags({ args: ["rate", EID, SID, "--down"] });
    expect(r.errors).toEqual([]);
    expect(r.rate?.direction).toBe("down");
  });

  it("rate: errors on missing positional args", () => {
    const r = parseFeedbackFlags({ args: ["rate"] });
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing edition_id"),
        expect.stringContaining("missing story_id"),
      ]),
    );
    expect(r.rate).toBeUndefined();
  });

  it("rate: errors on invalid UUID format", () => {
    const r = parseFeedbackFlags({ args: ["rate", "not-a-uuid", "also-bad"] });
    expect(r.errors.some((e) => e.includes("invalid edition_id UUID"))).toBe(true);
    expect(r.errors.some((e) => e.includes("invalid story_id UUID"))).toBe(true);
    expect(r.rate).toBeUndefined();
  });

  it("hide: parses source_url", () => {
    const r = parseFeedbackFlags({ args: ["hide", "https://example.com/a"] });
    expect(r.errors).toEqual([]);
    expect(r.subcommand).toBe("hide");
    expect(r.hide?.sourceUrl).toBe("https://example.com/a");
  });

  it("hide: errors on missing url", () => {
    const r = parseFeedbackFlags({ args: ["hide"] });
    expect(r.errors[0]).toMatch(/missing source_url/);
    expect(r.hide).toBeUndefined();
  });

  it("star: parses chunk_id", () => {
    const r = parseFeedbackFlags({ args: ["star", "chunk-abc"] });
    expect(r.errors).toEqual([]);
    expect(r.subcommand).toBe("star");
    expect(r.star?.chunkId).toBe("chunk-abc");
  });

  it("star: errors on missing chunk_id", () => {
    const r = parseFeedbackFlags({ args: ["star"] });
    expect(r.errors[0]).toMatch(/missing chunk_id/);
    expect(r.star).toBeUndefined();
  });

  it("--help / -h at top level (and per subcommand)", () => {
    expect(parseFeedbackFlags({ args: ["--help"] }).help).toBe(true);
    expect(parseFeedbackFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseFeedbackFlags({ args: ["--help"] }).errors).toEqual([]);
    expect(parseFeedbackFlags({ args: ["rate", "--help"] }).help).toBe(true);
    expect(parseFeedbackFlags({ args: ["hide", "-h"] }).help).toBe(true);
    expect(parseFeedbackFlags({ args: ["star", "--help"] }).help).toBe(true);
  });

  it("unknown subcommand errors", () => {
    const r = parseFeedbackFlags({ args: ["bogus"] });
    expect(r.errors).toEqual(["unknown subcommand: bogus"]);
    expect(r.help).toBe(false);
    expect(r.subcommand).toBeUndefined();
  });

  it("empty args errors with missing-subcommand message", () => {
    const r = parseFeedbackFlags({ args: [] });
    expect(r.errors[0]).toMatch(/missing subcommand/);
    expect(r.help).toBe(false);
  });
});

describe("runFeedbackCommand", () => {
  it("rate --up: writes story_up signal, exit 0", async () => {
    const signalRepo = makeFakeSignalRepo();
    const editionRepo = makeFakeEditionRepo({ byId: fakeEdition({ id: EID }) });
    const storyRepo = makeFakeStoryRepo({ byId: fakeStory({ id: SID }) });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      editionRepo,
      storyRepo,
      args: ["rate", EID, SID],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(r.signalId).toBe("sig-1");
    expect(signalRepo.createBatch).toHaveBeenCalledWith([
      {
        signal_kind: "story_up",
        edition_id: EID,
        story_id: SID,
        source_identity: null,
        payload: { direction: "up" },
      },
    ]);
    expect(editionRepo.getById).toHaveBeenCalledWith(EID);
    expect(storyRepo.getById).toHaveBeenCalledWith(SID);
    expect(logs.some((l) => l.includes("story_up"))).toBe(true);
  });

  it("rate --down: writes story_down signal, exit 0", async () => {
    const signalRepo = makeFakeSignalRepo();
    const editionRepo = makeFakeEditionRepo({ byId: fakeEdition({ id: EID }) });
    const storyRepo = makeFakeStoryRepo({ byId: fakeStory({ id: SID }) });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      editionRepo,
      storyRepo,
      args: ["rate", EID, SID, "--down"],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(signalRepo.createBatch).toHaveBeenCalledWith([
      {
        signal_kind: "story_down",
        edition_id: EID,
        story_id: SID,
        source_identity: null,
        payload: { direction: "down" },
      },
    ]);
    expect(logs.some((l) => l.includes("story_down"))).toBe(true);
  });

  it("rate: exits 1 when edition not found", async () => {
    const signalRepo = makeFakeSignalRepo();
    const editionRepo = makeFakeEditionRepo({ byId: undefined });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      editionRepo,
      args: ["rate", EID, SID],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    expect(r.exitCode).toBe(1);
    expect(signalRepo.createBatch).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("edition not found"))).toBe(true);
  });

  it("hide: writes source_muted signal with derived source_identity, exit 0", async () => {
    const url = "https://example.com/article";
    const doc = fakeDocument({ source_type: "article", publisher: null, metadata: null });
    const signalRepo = makeFakeSignalRepo();
    const editionRepo = makeFakeEditionRepo({ byDate: fakeEdition({ id: "ed-1" }) });
    const docRepo = makeFakeDocRepo({ byEditionAndUrl: doc });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      editionRepo,
      docRepo,
      args: ["hide", url],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    const expectedIdentity = deriveSourceIdentity({
      sourceUrl: url,
      sourceType: "article",
      publisher: null,
      metadata: null,
    });
    expect(r.exitCode).toBe(0);
    expect(signalRepo.createBatch).toHaveBeenCalledWith([
      {
        signal_kind: "source_muted",
        edition_id: "ed-1",
        source_url: url,
        source_identity: expectedIdentity,
        payload: { url },
      },
    ]);
    expect(docRepo.getByEditionAndUrl).toHaveBeenCalledWith("ed-1", url);
    expect(logs.some((l) => l.includes("source_muted"))).toBe(true);
    expect(logs.some((l) => l.includes("example.com"))).toBe(true);
  });

  it("star: writes chunk_starred signal, exit 0", async () => {
    const chunk = fakeChunk({ id: "chunk-1", document_id: "doc-1" });
    const doc = fakeDocument({ id: "doc-1", edition_id: "ed-1" });
    const signalRepo = makeFakeSignalRepo();
    const chunkRepo = makeFakeChunkRepo({ byId: chunk });
    const docRepo = makeFakeDocRepo({ byId: doc });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      chunkRepo,
      docRepo,
      args: ["star", "chunk-1"],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(chunkRepo.getById).toHaveBeenCalledWith("chunk-1");
    expect(docRepo.getById).toHaveBeenCalledWith("doc-1");
    expect(signalRepo.createBatch).toHaveBeenCalledWith([
      {
        signal_kind: "chunk_starred",
        edition_id: "ed-1",
        chunk_id: "chunk-1",
        document_id: "doc-1",
        payload: {},
      },
    ]);
    expect(logs.some((l) => l.includes("chunk_starred"))).toBe(true);
  });

  it("star: exits 1 when chunk not found", async () => {
    const signalRepo = makeFakeSignalRepo();
    const chunkRepo = makeFakeChunkRepo({ byId: undefined });
    const logs: string[] = [];
    const deps = makeDeps({
      signalRepo,
      chunkRepo,
      args: ["star", "nope"],
      log: (m) => logs.push(m),
    });

    const r = await runFeedbackCommand(deps);

    expect(r.exitCode).toBe(1);
    expect(signalRepo.createBatch).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("chunk not found"))).toBe(true);
  });
});

describe("FEEDBACK_HELP", () => {
  it("mentions all three subcommands", () => {
    expect(FEEDBACK_HELP).toContain("rate");
    expect(FEEDBACK_HELP).toContain("hide");
    expect(FEEDBACK_HELP).toContain("star");
    expect(FEEDBACK_HELP).toContain("story_up");
    expect(FEEDBACK_HELP).toContain("story_down");
    expect(FEEDBACK_HELP).toContain("source_muted");
    expect(FEEDBACK_HELP).toContain("chunk_starred");
  });
});
