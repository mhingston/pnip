import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FEEDBACK_SUMMARY_HELP,
  parseFeedbackSummaryFlags,
  runFeedbackSummaryCommand,
  type FeedbackSummaryCommandDeps,
} from "./feedback-summary.js";
import type { Kysely } from "kysely";
import type { Database, Edition } from "../database/kysely.js";
import type {
  SignalRepository,
  FeedbackSummary,
  SourceIdentityStats,
} from "../signals/signal-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import { createEditionRepository } from "../editions/edition-repository.js";

vi.mock("../editions/edition-repository.js", () => ({
  createEditionRepository: vi.fn(),
}));

const mockedCreateEditionRepository = vi.mocked(createEditionRepository);

function fakeEdition(overrides?: Partial<Edition>): Edition {
  return {
    id: overrides?.id ?? "ed-uuid",
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
    ...overrides,
  };
}

function makeFakeEditionRepo(opts: {
  byDate?: Edition | undefined;
  error?: Error;
} = {}): EditionRepository {
  return {
    create: vi.fn().mockResolvedValue(fakeEdition()),
    getById: vi.fn().mockResolvedValue(fakeEdition()),
    getByDate: opts.error
      ? vi.fn().mockRejectedValue(opts.error)
      : vi.fn().mockResolvedValue(opts.byDate),
    getOrCreateForDate: vi.fn().mockResolvedValue(fakeEdition()),
    transition: vi.fn().mockResolvedValue(fakeEdition()),
    isProcessingAllowed: vi.fn().mockResolvedValue(true),
    assertProcessingAllowed: vi.fn().mockResolvedValue(fakeEdition()),
  };
}

function fakeSummary(overrides?: Partial<FeedbackSummary>): FeedbackSummary {
  return {
    signalCounts: {},
    totalSignals: 0,
    topMutedSources: [],
    topVotedStories: [],
    topStarredChunks: [],
    sourceIdentityCount: 0,
    storyVoteCount: 0,
    ...overrides,
  };
}

function fakeStats(
  overrides?: Partial<SourceIdentityStats>,
): SourceIdentityStats {
  return {
    source_identity: "theverge.com",
    mute_count: 0,
    chunk_star_count: 0,
    cited_in_story_count: 0,
    total_signals: 0,
    ...overrides,
  };
}

function makeFakeSignalRepo(): SignalRepository {
  return {
    createBatch: vi.fn().mockResolvedValue([]),
    getByEdition: vi.fn().mockResolvedValue([]),
    getByEditionAndKind: vi.fn().mockResolvedValue([]),
    countByEditionAndKind: vi.fn().mockResolvedValue(0),
    getBySourceIdentity: vi.fn().mockResolvedValue([]),
    getFeedbackSummary: vi
      .fn()
      .mockResolvedValue(fakeSummary()),
    getSourceIdentityStats: vi
      .fn()
      .mockResolvedValue(fakeStats()),
  };
}

function makeFakeDb(): Kysely<Database> {
  return {} as unknown as Kysely<Database>;
}

function makeDeps(overrides: {
  signalRepo?: SignalRepository;
  args?: string[];
  log?: (m: string) => void;
} = {}): { deps: FeedbackSummaryCommandDeps; logs: string[] } {
  const logs: string[] = [];
  const deps: FeedbackSummaryCommandDeps = {
    db: makeFakeDb(),
    signalRepo: overrides.signalRepo ?? makeFakeSignalRepo(),
    args: overrides.args ?? [],
    log: overrides.log ?? ((m: string) => logs.push(m)),
  };
  return { deps, logs };
}

describe("parseFeedbackSummaryFlags", () => {
  it("defaults: empty args gives limit=10, no help, no errors", () => {
    const r = parseFeedbackSummaryFlags({ args: [] });
    expect(r.limit).toBe(10);
    expect(r.help).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.edition).toBeUndefined();
    expect(r.sourceIdentity).toBeUndefined();
  });

  it("parses --edition <date>", () => {
    const r = parseFeedbackSummaryFlags({
      args: ["--edition", "2026-07-08"],
    });
    expect(r.edition).toBe("2026-07-08");
    expect(r.errors).toEqual([]);
  });

  it("errors when --edition is missing a value", () => {
    const r = parseFeedbackSummaryFlags({ args: ["--edition"] });
    expect(r.errors[0]).toMatch(/--edition requires a value/);
  });

  it("parses --source-identity <key>", () => {
    const r = parseFeedbackSummaryFlags({
      args: ["--source-identity", "theverge.com"],
    });
    expect(r.sourceIdentity).toBe("theverge.com");
    expect(r.errors).toEqual([]);
  });

  it("errors when --source-identity is missing a value", () => {
    const r = parseFeedbackSummaryFlags({ args: ["--source-identity"] });
    expect(r.errors[0]).toMatch(/--source-identity requires a value/);
  });

  it("parses --limit <n>", () => {
    const r = parseFeedbackSummaryFlags({ args: ["--limit", "25"] });
    expect(r.limit).toBe(25);
    expect(r.errors).toEqual([]);
  });

  it("errors on --limit with non-positive integer", () => {
    expect(
      parseFeedbackSummaryFlags({ args: ["--limit", "0"] }).errors[0],
    ).toMatch(/--limit must be a positive integer/);
    expect(
      parseFeedbackSummaryFlags({ args: ["--limit", "-1"] }).errors[0],
    ).toMatch(/--limit must be a positive integer/);
    expect(
      parseFeedbackSummaryFlags({ args: ["--limit", "abc"] }).errors[0],
    ).toMatch(/--limit must be a positive integer/);
  });

  it("errors when --limit is missing a value", () => {
    const r = parseFeedbackSummaryFlags({ args: ["--limit"] });
    expect(r.errors[0]).toMatch(/--limit requires a value/);
  });

  it("recognises -h and --help as help requests", () => {
    expect(parseFeedbackSummaryFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseFeedbackSummaryFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on unknown flags", () => {
    const r = parseFeedbackSummaryFlags({ args: ["--bogus"] });
    expect(r.errors[0]).toMatch(/unknown flag: --bogus/);
  });

  it("errors on unexpected positional args", () => {
    const r = parseFeedbackSummaryFlags({ args: ["positional"] });
    expect(r.errors[0]).toMatch(/unexpected positional arg: positional/);
  });
});

describe("runFeedbackSummaryCommand", () => {
  beforeEach(() => {
    mockedCreateEditionRepository.mockReset();
    mockedCreateEditionRepository.mockReturnValue(
      makeFakeEditionRepo({ byDate: fakeEdition() }),
    );
  });

  it("aggregate mode: calls getFeedbackSummary, logs summary, exit 0", async () => {
    const signalRepo = makeFakeSignalRepo();
    const summary = fakeSummary({
      signalCounts: { story_up: 3, story_down: 1, source_muted: 2 },
      totalSignals: 6,
      sourceIdentityCount: 2,
      storyVoteCount: 2,
      topMutedSources: [
        { source_identity: "theverge.com", mute_count: 2 },
      ],
      topVotedStories: [
        {
          story_id: "story-1",
          net_score: 2,
          up: 3,
          down: 1,
        },
      ],
      topStarredChunks: [{ chunk_id: "chunk-7", star_count: 4 }],
    });
    vi.mocked(signalRepo.getFeedbackSummary).mockResolvedValue(summary);

    const { deps, logs } = makeDeps({ signalRepo });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(r.summary).toBe(summary);
    expect(signalRepo.getFeedbackSummary).toHaveBeenCalledTimes(1);
    expect(signalRepo.getSourceIdentityStats).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) =>
          l.startsWith("feedback summary for edition") &&
          l.includes("(2026-07-08)"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("total signals: 6") &&
          l.includes("2 source identities") &&
          l.includes("2 stories with votes"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("by kind: "))).toBe(true);
    expect(logs.some((l) => l.includes("top muted sources:"))).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("theverge.com") && l.includes("(2 mutes)"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("top voted stories:"))).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("story-1") &&
          l.includes("net=+2") &&
          l.includes("(up=3 down=1)"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("top starred chunks:"))).toBe(true);
    expect(
      logs.some((l) => l.includes("chunk-7") && l.includes("(4 stars)")),
    ).toBe(true);
  });

  it("aggregate mode: passes --limit and --edition via edition lookup", async () => {
    const signalRepo = makeFakeSignalRepo();
    const summary = fakeSummary({ totalSignals: 0 });
    vi.mocked(signalRepo.getFeedbackSummary).mockResolvedValue(summary);

    const { deps } = makeDeps({
      signalRepo,
      args: ["--edition", "2026-07-08", "--limit", "5"],
    });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(signalRepo.getFeedbackSummary).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("aggregate mode: empty data logs total=0 and skips empty top sections", async () => {
    const signalRepo = makeFakeSignalRepo();
    vi.mocked(signalRepo.getFeedbackSummary).mockResolvedValue(
      fakeSummary({
        totalSignals: 0,
        sourceIdentityCount: 0,
        storyVoteCount: 0,
      }),
    );

    const { deps, logs } = makeDeps({ signalRepo });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("total signals: 0"))).toBe(true);
    expect(logs.some((l) => l.includes("by kind:"))).toBe(false);
    expect(logs.some((l) => l.includes("top muted sources"))).toBe(false);
    expect(logs.some((l) => l.includes("top voted stories"))).toBe(false);
    expect(logs.some((l) => l.includes("top starred chunks"))).toBe(false);
  });

  it("aggregate mode: renders negative net score with sign", async () => {
    const signalRepo = makeFakeSignalRepo();
    vi.mocked(signalRepo.getFeedbackSummary).mockResolvedValue(
      fakeSummary({
        topVotedStories: [
          { story_id: "story-bad", net_score: -3, up: 1, down: 4 },
        ],
      }),
    );

    const { deps, logs } = makeDeps({ signalRepo });
    await runFeedbackSummaryCommand(deps);

    expect(
      logs.some(
        (l) =>
          l.includes("story-bad") &&
          l.includes("net=-3") &&
          l.includes("(up=1 down=4)"),
      ),
    ).toBe(true);
  });

  it("source mode: calls getSourceIdentityStats, logs 5-line report, exit 0", async () => {
    const signalRepo = makeFakeSignalRepo();
    vi.mocked(signalRepo.getSourceIdentityStats).mockResolvedValue(
      fakeStats({
        source_identity: "reddit.com/r/machinelearning",
        mute_count: 4,
        chunk_star_count: 2,
        cited_in_story_count: 3,
        total_signals: 11,
      }),
    );

    const { deps, logs } = makeDeps({
      signalRepo,
      args: ["--source-identity", "reddit.com/r/machinelearning"],
    });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(r.sourceStats).toBeDefined();
    expect(signalRepo.getSourceIdentityStats).toHaveBeenCalledWith(
      "reddit.com/r/machinelearning",
    );
    expect(signalRepo.getFeedbackSummary).not.toHaveBeenCalled();
    expect(
      logs.some((l) =>
        l.includes("source_identity: reddit.com/r/machinelearning"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("mute_count: 4"))).toBe(true);
    expect(logs.some((l) => l.includes("chunk_star_count: 2"))).toBe(true);
    expect(logs.some((l) => l.includes("cited_in_story_count: 3"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("total_signals: 11"))).toBe(true);
    expect(logs.some((l) => l.includes("feedback summary for edition"))).toBe(
      false,
    );
  });

  it("--help logs the help text and exits 0", async () => {
    const { deps, logs } = makeDeps({ args: ["--help"] });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(0);
    expect(logs[0]).toBe(FEEDBACK_SUMMARY_HELP);
  });

  it("exits 1 with clear message when no edition exists for the date", async () => {
    mockedCreateEditionRepository.mockReturnValue(
      makeFakeEditionRepo({ byDate: undefined }),
    );
    const signalRepo = makeFakeSignalRepo();
    const { deps, logs } = makeDeps({ signalRepo });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(1);
    expect(
      logs.some((l) =>
        l.startsWith("feedback-summary: no edition for date"),
      ),
    ).toBe(true);
    expect(signalRepo.getFeedbackSummary).not.toHaveBeenCalled();
    expect(signalRepo.getSourceIdentityStats).not.toHaveBeenCalled();
  });

  it("exits 1 with clear message when no edition exists for the date", async () => {
    mockedCreateEditionRepository.mockReturnValue(
      makeFakeEditionRepo({ byDate: undefined }),
    );
    const signalRepo = makeFakeSignalRepo();
    const { deps, logs } = makeDeps({ signalRepo });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(1);
    expect(
      logs.some((l) =>
        l.startsWith("feedback-summary: no edition for date"),
      ),
    ).toBe(true);
    expect(signalRepo.getFeedbackSummary).not.toHaveBeenCalled();
    expect(signalRepo.getSourceIdentityStats).not.toHaveBeenCalled();
  });

  it("invalid flags: exits 2 and logs help after the error lines", async () => {
    const { deps, logs } = makeDeps({ args: ["--bogus"] });
    const r = await runFeedbackSummaryCommand(deps);

    expect(r.exitCode).toBe(2);
    expect(logs[0]).toMatch(/unknown flag: --bogus/);
    expect(logs).toContain(FEEDBACK_SUMMARY_HELP);
  });
});

describe("FEEDBACK_SUMMARY_HELP", () => {
  it("mentions all flags and read-only guarantee", () => {
    expect(FEEDBACK_SUMMARY_HELP).toContain("--edition");
    expect(FEEDBACK_SUMMARY_HELP).toContain("--source-identity");
    expect(FEEDBACK_SUMMARY_HELP).toContain("--limit");
    expect(FEEDBACK_SUMMARY_HELP).toContain("-h");
    expect(FEEDBACK_SUMMARY_HELP).toContain("--help");
    expect(FEEDBACK_SUMMARY_HELP).toMatch(/read-only/i);
  });
});