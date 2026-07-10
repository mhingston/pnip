import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMarkdownDigestService,
  DIGEST_CATEGORY_ORDER,
  type StorySnapshot,
  type MarkdownDigestServiceDeps,
} from "./markdown-digest-service.js";
import { buildCitationIndex } from "./citation-index.js";
import type { Edition } from "../../database/kysely.js";
import type { Logger } from "../../logging/logger.js";
import type { CreateSignalInput } from "../../signals/signal-repository.js";
import { getBiasView, type BiasView } from "../../signals/bias-view.js";

vi.mock("../../signals/bias-view.js", () => ({
  getBiasView: vi.fn(),
}));

function silentLogger(): Logger {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: function () {
      return this;
    },
  } as unknown as Logger;
}

function makeEdition(overrides: Partial<Edition> = {}): Edition {
  return {
    id: "ed-1",
    publication_date: new Date("2026-07-07T00:00:00Z"),
    status: "ready",
    created_at: new Date("2026-07-07T00:00:00Z"),
    updated_at: new Date("2026-07-07T00:00:00Z"),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    partition_key: "master",
    ...overrides,
  };
}

const DUMMY_ASSEMBLY = {
  totalDocuments: 0,
  fullyEnrichedDocuments: 0,
  expectedCompletedTypeRows: 0,
  totalCompletedTypeRows: 0,
  storiesWithSummaries: 0,
  isReady: true,
  reason: "all documents fully enriched and all stories have summaries",
};

describe("categorizeStory", () => {
  const baseDeps = () => ({
    db: {} as never,
    editionRepo: {} as never,
    assembly: {} as never,
    storySummaryRepo: {} as never,
    docRepo: {} as never,
    chunkRepo: { getByDocumentId: async () => [] } as never,
    topicRepo: {} as never,
    digestRepo: {} as never,
    signalRepo: {} as never,
    logger: silentLogger(),
  });

  it("routes Reddit documents to Reddit Discussions", () => {
    const svc = createMarkdownDigestService(baseDeps());
    const story: StorySnapshot = {
      storyId: "s1",
      storyLabel: "Discussion thread about X",
      clusterOrder: 0,
      summaryText: "",
      claims: [],
      documents: [
        {
          id: "d1",
          title: "Thread",
          sourceUrl: "https://reddit.com/r/foo/comments/1",
          canonicalUrl: "https://reddit.com/r/foo/comments/1",
          sourceType: "reddit",
          publisher: null,
        chunkIds: [],
        },
      ],
    };
    expect(svc.categorizeStory(story)).toBe("Reddit Discussions");
  });

  it("routes youtube/podcast to Videos", () => {
    const svc = createMarkdownDigestService(baseDeps());
    expect(
      svc.categorizeStory({
        storyId: "s",
        storyLabel: "Cat video",
        clusterOrder: 0,
        summaryText: "",
        claims: [],
        documents: [
          {
            id: "d1",
            title: "Cat",
            sourceUrl: "https://youtube.com/watch?v=abc",
            canonicalUrl: null,
            sourceType: "youtube",
            publisher: null,
          chunkIds: [],
          },
        ],
      }),
    ).toBe("Videos");
    expect(
      svc.categorizeStory({
        storyId: "s",
        storyLabel: "Tech podcast",
        clusterOrder: 0,
        summaryText: "",
        claims: [],
        documents: [
          {
            id: "d1",
            title: "EP1",
            sourceUrl: "https://example.com/ep1.mp3",
            canonicalUrl: null,
            sourceType: "podcast",
            publisher: null,
          chunkIds: [],
          },
        ],
      }),
    ).toBe("Videos");
  });

  it("routes technology keywords to Technology", () => {
    const svc = createMarkdownDigestService(baseDeps());
    expect(
      svc.categorizeStory({
        storyId: "s",
        storyLabel: "OpenAI ships new agent",
        clusterOrder: 0,
        summaryText: "",
        claims: [],
        documents: [
          {
            id: "d1",
            title: "Story",
            sourceUrl: "https://example.com/a",
            canonicalUrl: null,
            sourceType: "article",
            publisher: null,
          chunkIds: [],
          },
        ],
      }),
    ).toBe("Technology");
  });

  it("routes politics keywords to Politics", () => {
    const svc = createMarkdownDigestService(baseDeps());
    expect(
      svc.categorizeStory({
        storyId: "s",
        storyLabel: "Senate Vote",
        clusterOrder: 0,
        summaryText: "",
        claims: [],
        documents: [
          {
            id: "d1",
            title: "Senate Vote",
            sourceUrl: "https://example.com/a",
            canonicalUrl: null,
            sourceType: "article",
            publisher: null,
          chunkIds: [],
          },
        ],
      }),
    ).toBe("Politics");
  });

  it("falls back to Interesting Reads when nothing matches", () => {
    const svc = createMarkdownDigestService(baseDeps());
    expect(
      svc.categorizeStory({
        storyId: "s",
        storyLabel: "Quiet town festival",
        clusterOrder: 0,
        summaryText: "",
        claims: [],
        documents: [
          {
            id: "d1",
            title: "Festival",
            sourceUrl: "https://example.com/a",
            canonicalUrl: null,
            sourceType: "article",
            publisher: null,
          chunkIds: [],
          },
        ],
      }),
    ).toBe("Interesting Reads");
  });
});

describe("renderMarkdown", () => {
  const baseDeps = () => ({
    db: {} as never,
    editionRepo: {} as never,
    assembly: {} as never,
    storySummaryRepo: {} as never,
    docRepo: {} as never,
    chunkRepo: { getByDocumentId: async () => [] } as never,
    topicRepo: {} as never,
    digestRepo: {} as never,
    signalRepo: {} as never,
    logger: silentLogger(),
  });
  const svc = createMarkdownDigestService(baseDeps());

  it("renders the title with the publication date", () => {
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories: [],
      citationIndex: buildCitationIndex([]),
    });
    expect(md).toContain("## Top Stories");
    expect(md).not.toContain("## Table of Contents");
    expect(md).not.toContain("Edition 2026-07-07 ·");
  });

  it("always emits Sources section even with no stories", () => {
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories: [],
      citationIndex: buildCitationIndex([]),
    });
    expect(md).toContain("## Sources");
  });

  it("renders a layered briefing with a flat More Stories section", () => {
    const stories: StorySnapshot[] = [
      // First 5 go into Top Stories (one per category); the rest are bucketed.
      ...makeNStories(2, "Technology", "ai"),
      ...makeNStories(1, "Politics", "election"),
      ...makeNStories(1, "Science", "research"),
      ...makeNStories(1, "Business", "funding"),
      // 6th story spills into a category bucket (Technology, since cluster_order 5)
      makeStoryAt("s6", 5, "Technology", "ai"),
      // A youtube video that goes into Videos (7th story after top-5)
      makeStoryAt("s7", 6, "Videos", "", { sourceType: "youtube", url: "https://youtube.com/watch?v=xyz" }),
      makeStoryAt("s8", 7, "Reddit Discussions", "", { sourceType: "reddit", url: "https://reddit.com/r/foo/comments/1" }),
    ];
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idx,
    });

    expect(md).toContain("## Top Stories");
    expect(md).not.toContain("## Today in brief");
    expect(md).not.toMatch(/^## Technology$/m);
    expect(md).not.toMatch(/^## Videos$/m);
    expect(md).not.toMatch(/^## Reddit Discussions$/m);
    expect(md).not.toContain("## Closing Summary");
    expect(md).toContain("## Sources");
  });

  it("omits the Executive Summary and per-story Sources line", () => {
    const stories = makeNStories(2, "Technology", "ai");
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idx,
    });
    expect(md).not.toContain("## Executive Summary");
    expect(md).not.toContain("_Sources:_");
    expect(md).toContain("## Top Stories");
  });

  it("uses deterministic citation numbering across two renders", () => {
    const stories = makeNStories(2, "Technology", "ai");
    const idxA = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));
    const idxB = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));
    const mdA = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idxA,
    });
    const mdB = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idxB,
    });
    expect(mdA).toBe(mdB);
  });

  it("renders reader-friendly Key details without citation tokens", () => {
    const stories = makeNStories(1, "Technology", "ai");
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idx,
    });
    expect(md).toContain("_Key details:_");
    expect(md).not.toContain("_Claims:_");
    expect(md).not.toMatch(/\[\d+\]/);
  });

  it("preserves generated summaries beyond the former top-five limit", () => {
    const stories = makeNStories(6, "Technology", "ai");
    stories[5]!.summaryText = "A distinctive sixth-story summary that must remain visible.";
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));

    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idx,
    });

    expect(md).not.toContain("## More Stories");
    expect(md).toContain("A distinctive sixth-story summary that must remain visible.");
  });

  it("preserves a story summary and source even when it has no key details", () => {
    const story = makeStoryAt("summary-only", 0, "Technology", "ai");
    story.summaryText = "A useful summary backed by the story's source.";
    story.claims = [];

    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories: [story],
      citationIndex: buildCitationIndex([]),
    });

    expect(md).toContain("A useful summary backed by the story's source.");
    expect(md).toContain("https://example.com/summary-only");
  });

  it("omits the redundant Today in brief section", () => {
    const stories = makeNStories(2, "Technology", "ai");
    stories[0]!.summaryText = "First development happened. Extra context follows.";
    stories[1]!.summaryText = "Second development happened! More detail follows.";
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));

    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: idx,
    });

    expect(md).not.toContain("## Today in brief");
  });

  it("groups explainable cross-day repeats without dropping their summary or source", () => {
    const stories = makeNStories(2, "Technology", "ai");
    stories[1]!.summaryText = "Fresh details in continuing coverage remain fully readable.";
    const idx = buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text }))));

    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      previousStories: [{ label: "Yesterday's agent report", urls: ["https://example2.com/x"] }],
      citationIndex: idx,
    });

    expect(md).toContain("## Continuing coverage");
    expect(md).toContain("repeated 1 story");
    expect(md).toContain("Stories also covered in the previous edition.");
    expect(md).not.toContain("Updates to stories");
    expect(md).toContain("Continues yesterday's coverage: Yesterday's agent report (same source).");
    expect(md).toContain("Fresh details in continuing coverage remain fully readable.");
    expect(md).toContain("https://example2.com/x");
  });

  it("describes an all-continuing edition without claiming that it has no stories", () => {
    const stories = makeNStories(1, "Technology", "ai");
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      previousStories: [{ label: "Yesterday's coverage", urls: ["https://example1.com/x"] }],
      citationIndex: buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text })))),
    });

    expect(md).toContain("_No new lead stories; continuing coverage follows._");
    expect(md).not.toContain("No stories selected for this edition");
    expect(md).not.toContain("No top stories selected for this edition");
  });

  it("uses an optional reading target to calibrate prominence without dropping stories or sources", () => {
    const stories = makeNStories(6, "Technology", "ai");
    const calibrated = createMarkdownDigestService({
      ...baseDeps(),
      presentation: { targetReadingMinutes: 4 },
    });
    const md = calibrated.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY, totalDocuments: 6 },
      stories,
      citationIndex: buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text })))),
    });
    const top = md.slice(md.indexOf("## Top Stories"), md.indexOf("## More Stories"));
    expect(top.match(/^### /gm)).toHaveLength(2);
    for (const story of stories) {
      expect(md).toContain(story.summaryText);
      expect(md).toContain(story.documents[0]!.sourceUrl);
    }
  });

  it("includes up to fifty lead stories by default", () => {
    const stories = makeNStories(6, "Technology", "ai");
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY },
      stories,
      citationIndex: buildCitationIndex(stories.flatMap((s) => s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text })))),
    });
    const top = md.slice(md.indexOf("## Top Stories"), md.indexOf("## More Stories"));
    expect(top.match(/^### /gm)).toHaveLength(6);
  });

  it("frames a quiet edition only when an explicit significance or novelty assessment exists", () => {
    const story = makeNStories(1, "Technology", "ai");
    const ordinary = svc.renderMarkdown({ edition: makeEdition(), assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY }, stories: story, citationIndex: buildCitationIndex([]) });
    expect(ordinary).not.toContain("Quiet edition");

    const quiet = createMarkdownDigestService({ ...baseDeps(), presentation: { quietEditionReason: "low_novelty" } });
    const framed = quiet.renderMarkdown({ edition: makeEdition(), assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY }, stories: story, citationIndex: buildCitationIndex([]) });
    expect(framed).toContain("Quiet edition");
    expect(framed).toContain("limited novelty");
    expect(framed).not.toContain("no input");
    expect(framed).not.toContain("no stories");
  });

  it("adds a compact coverage receipt containing only supported metrics", () => {
    const stories = makeNStories(2, "Technology", "ai");
    const md = svc.renderMarkdown({
      edition: makeEdition(),
      assembly: { edition: makeEdition(), stories: [], ...DUMMY_ASSEMBLY, totalDocuments: 2, fullyEnrichedDocuments: 2 },
      stories,
      citationIndex: buildCitationIndex([]),
    });
    expect(md).toContain("_Coverage: reviewed 2 sources; included 2 sources across 2 stories._");
    expect(md).not.toMatch(/repeated|suppressed|excluded|failures/i);
  });
});

describe("generate", () => {
  it("returns alreadyExisted=true when a digest already exists", async () => {
    const existing = {
      id: "md-1",
      edition_id: "ed-1",
      content: "stale",
      story_count: 1,
      document_count: 2,
      citation_count: 3,
      created_at: new Date(),
    };
    const digestRepo = {
      createForEdition: vi.fn(),
      getByEdition: vi.fn().mockResolvedValue(existing),
      deleteByEdition: vi.fn(),
    };
    const editionRepo = {
      getById: vi.fn().mockResolvedValue(makeEdition()),
      getByDate: vi.fn(),
    };
    const svc = createMarkdownDigestService({
      db: {} as never,
      editionRepo: editionRepo as never,
      assembly: {} as never,
      storySummaryRepo: {} as never,
      docRepo: {} as never,
      chunkRepo: { getByDocumentId: async () => [] } as never,
      topicRepo: {} as never,
      digestRepo: digestRepo as never,
      signalRepo: { createBatch: vi.fn().mockResolvedValue([]) } as never,
      logger: silentLogger(),
    });

    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.digestId).toBe("md-1");
    expect(digestRepo.createForEdition).not.toHaveBeenCalled();
  });

  it("persists the rendered markdown and returns deterministic counters", async () => {
    const stories = makeNStories(3, "Technology", "ai");
    const allCitations = stories.flatMap((s) =>
      s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text })),
    );
    const citationIndex = buildCitationIndex(allCitations);
    const assembledStories = stories.map((s) => makeAssembled(s));
    const digestRepo = {
      createForEdition: vi.fn().mockResolvedValue({
        id: "md-2",
        edition_id: "ed-1",
        content: "x",
        story_count: 3,
        document_count: 3,
        citation_count: citationIndex.entries.length,
        created_at: new Date(),
      }),
      getByEdition: vi.fn().mockResolvedValue(undefined),
      deleteByEdition: vi.fn(),
    };
    const editionRepo = {
      getById: vi.fn().mockResolvedValue(makeEdition()),
      getByDate: vi.fn(),
    };
    const storySummaryRepo = {
      getByStoryId: vi.fn().mockImplementation(async (storyId: string) => {
        const snap = stories.find((s) => s.storyId === storyId)!;
        return {
          id: `sum-${storyId}`,
          story_id: storyId,
          content: snap.summaryText,
          prompt_id: "p1",
          prompt_version: 1,
          model: "fake",
          provider: "fake",
          input_hash: "h",
          created_at: new Date(),
        };
      }),
      getCitationsBySummaryId: vi.fn().mockImplementation(async (summaryId: string) => {
        const storyId = summaryId.replace(/^sum-/, "");
        const snap = stories.find((s) => s.storyId === storyId)!;
        return snap.claims.map((c, i) => ({
          id: `cit-${storyId}-${i}`,
          story_summary_id: summaryId,
          chunk_id: c.chunkId,
          claim_text: c.text,
          claim_order: i,
          created_at: new Date(),
        }));
      }),
      replaceForStory: vi.fn(),
      deleteByStoryId: vi.fn(),
    };
    const docRepo = {
      getById: vi.fn().mockImplementation(async (documentId: string) => {
        const snap = stories
          .flatMap((s) => s.documents)
          .find((d) => d.id === documentId);
        if (!snap) return undefined;
        return {
          id: snap.id,
          edition_id: "ed-1",
          source_type: snap.sourceType,
          source_url: snap.sourceUrl,
          canonical_url: snap.canonicalUrl,
          title: snap.title,
          subtitle: null,
          authors: [],
          publisher: snap.publisher,
          published_at: null,
          language: "en",
          content_markdown: null,
          content_text: null,
          metadata: {},
          created_at: new Date(),
        };
      }),
      getByEdition: vi.fn().mockResolvedValue([]),
      getByEditionAndUrl: vi.fn(),
      create: vi.fn(),
    };
    const assembly = {
      assemble: vi.fn().mockResolvedValue({
        edition: makeEdition(),
        stories: assembledStories,
        ...DUMMY_ASSEMBLY,
        totalDocuments: 3,
        fullyEnrichedDocuments: 3,
        storiesWithSummaries: 3,
      }),
      collectStories: vi.fn().mockResolvedValue(assembledStories),
      getReadiness: vi.fn(),
      isEditionReady: vi.fn(),
    };
    const svc = createMarkdownDigestService({
      db: {} as never,
      editionRepo: editionRepo as never,
      assembly: assembly as never,
      storySummaryRepo: storySummaryRepo as never,
      docRepo: docRepo as never,
      chunkRepo: { getByDocumentId: async () => [] } as never,
      topicRepo: {} as never,
      digestRepo: digestRepo as never,
      signalRepo: { createBatch: vi.fn().mockResolvedValue([]) } as never,
      logger: silentLogger(),
    });

    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(false);
    expect(result.storyCount).toBe(3);
    expect(result.citationCount).toBe(citationIndex.entries.length);
    expect(digestRepo.createForEdition).toHaveBeenCalledOnce();
    const arg = digestRepo.createForEdition.mock.calls[0]![0]!;
    expect(arg.content).toContain("## Top Stories");
  });

  it("recovers from a UNIQUE conflict by returning the existing row", async () => {
    const stories = makeNStories(2, "Politics", "election");
    const assembledStories = stories.map((s) => makeAssembled(s));
    const digestRepo = {
      createForEdition: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("dup"), { name: "MarkdownDigestConflictError" })),
      getByEdition: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          id: "md-3",
          edition_id: "ed-1",
          content: "x",
          story_count: 2,
          document_count: 2,
          citation_count: 1,
          created_at: new Date(),
        }),
      deleteByEdition: vi.fn(),
    };
    const assembly = {
      assemble: vi.fn().mockResolvedValue({
        edition: makeEdition(),
        stories: assembledStories,
        ...DUMMY_ASSEMBLY,
        totalDocuments: 2,
        fullyEnrichedDocuments: 2,
        storiesWithSummaries: 2,
      }),
      collectStories: vi.fn().mockResolvedValue(assembledStories),
      getReadiness: vi.fn(),
      isEditionReady: vi.fn(),
    };
    const editionRepo = {
      getById: vi.fn().mockResolvedValue(makeEdition()),
      getByDate: vi.fn(),
    };
    const storySummaryRepo = {
      getByStoryId: vi.fn().mockImplementation(async (storyId: string) => {
        const snap = stories.find((s) => s.storyId === storyId)!;
        return {
          id: `sum-${storyId}`,
          story_id: storyId,
          content: snap.summaryText,
          prompt_id: "p1",
          prompt_version: 1,
          model: "fake",
          provider: "fake",
          input_hash: "h",
          created_at: new Date(),
        };
      }),
      getCitationsBySummaryId: vi.fn().mockImplementation(async (summaryId: string) => {
        const storyId = summaryId.replace(/^sum-/, "");
        const snap = stories.find((s) => s.storyId === storyId)!;
        return snap.claims.map((c, i) => ({
          id: `cit-${storyId}-${i}`,
          story_summary_id: summaryId,
          chunk_id: c.chunkId,
          claim_text: c.text,
          claim_order: i,
          created_at: new Date(),
        }));
      }),
      replaceForStory: vi.fn(),
      deleteByStoryId: vi.fn(),
    };
    const docRepo = {
      getById: vi.fn().mockImplementation(async (documentId: string) => {
        const snap = stories
          .flatMap((s) => s.documents)
          .find((d) => d.id === documentId);
        if (!snap) return undefined;
        return {
          id: snap.id,
          edition_id: "ed-1",
          source_type: snap.sourceType,
          source_url: snap.sourceUrl,
          canonical_url: snap.canonicalUrl,
          title: snap.title,
          subtitle: null,
          authors: [],
          publisher: snap.publisher,
          published_at: null,
          language: "en",
          content_markdown: null,
          content_text: null,
          metadata: {},
          created_at: new Date(),
        };
      }),
      getByEdition: vi.fn().mockResolvedValue([]),
      getByEditionAndUrl: vi.fn(),
      create: vi.fn(),
    };
    const svc = createMarkdownDigestService({
      db: {} as never,
      editionRepo: editionRepo as never,
      assembly: assembly as never,
      storySummaryRepo: storySummaryRepo as never,
      docRepo: docRepo as never,
      chunkRepo: { getByDocumentId: async () => [] } as never,
      topicRepo: {} as never,
      digestRepo: digestRepo as never,
      signalRepo: { createBatch: vi.fn().mockResolvedValue([]) } as never,
      logger: silentLogger(),
    });
    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.digestId).toBe("md-3");
  });

  it("signals rendered novel leads, excluding a first-ranked repeated story", async () => {
    const stories = makeNStories(3, "Technology", "ai");
    const assembledStories = stories.map((s) => makeAssembled(s));
    const signalRepo = {
      createBatch: vi.fn().mockResolvedValue([]),
      getByEdition: vi.fn(),
      getByEditionAndKind: vi.fn(),
      countByEditionAndKind: vi.fn(),
      getBySourceIdentity: vi.fn(),
    };
    const digestRepo = {
      createForEdition: vi.fn().mockResolvedValue({
        id: "md-sig",
        edition_id: "ed-1",
        content: "x",
        story_count: 3,
        document_count: 3,
        citation_count: 6,
        created_at: new Date(),
      }),
      getByEdition: vi.fn().mockResolvedValue(undefined),
      deleteByEdition: vi.fn(),
    };
    const editionRepo = {
      getById: vi.fn().mockResolvedValue(makeEdition()),
      getByDate: vi.fn(),
    };
    const storySummaryRepo = {
      getByStoryId: vi.fn().mockImplementation(async (storyId: string) => {
        const snap = stories.find((s) => s.storyId === storyId)!;
        return {
          id: `sum-${storyId}`,
          story_id: storyId,
          content: snap.summaryText,
          prompt_id: "p1",
          prompt_version: 1,
          model: "fake",
          provider: "fake",
          input_hash: "h",
          created_at: new Date(),
        };
      }),
      getCitationsBySummaryId: vi.fn().mockImplementation(async (summaryId: string) => {
        const storyId = summaryId.replace(/^sum-/, "");
        const snap = stories.find((s) => s.storyId === storyId)!;
        return snap.claims.map((c, i) => ({
          id: `cit-${storyId}-${i}`,
          story_summary_id: summaryId,
          chunk_id: c.chunkId,
          claim_text: c.text,
          claim_order: i,
          created_at: new Date(),
        }));
      }),
      replaceForStory: vi.fn(),
      deleteByStoryId: vi.fn(),
    };
    const docRepo = {
      getById: vi.fn().mockImplementation(async (documentId: string) => {
        const snap = stories.flatMap((s) => s.documents).find((d) => d.id === documentId);
        if (!snap) return undefined;
        return {
          id: snap.id,
          edition_id: "ed-1",
          source_type: snap.sourceType,
          source_url: snap.sourceUrl,
          canonical_url: snap.canonicalUrl,
          title: snap.title,
          subtitle: null,
          authors: [],
          publisher: snap.publisher,
          published_at: null,
          language: "en",
          content_markdown: null,
          content_text: null,
          metadata: {},
          created_at: new Date(),
        };
      }),
      getByEdition: vi.fn().mockResolvedValue([]),
      getByEditionAndUrl: vi.fn(),
      create: vi.fn(),
    };
    const assembly = {
      assemble: vi.fn().mockResolvedValue({
        edition: makeEdition(),
        stories: assembledStories,
        ...DUMMY_ASSEMBLY,
        totalDocuments: 3,
        fullyEnrichedDocuments: 3,
        storiesWithSummaries: 3,
      }),
      collectStories: vi.fn().mockResolvedValue(assembledStories),
      getReadiness: vi.fn(),
      isEditionReady: vi.fn(),
    };
    const svc = createMarkdownDigestService({
      db: {} as never,
      editionRepo: editionRepo as never,
      assembly: assembly as never,
      storySummaryRepo: storySummaryRepo as never,
      docRepo: docRepo as never,
      chunkRepo: { getByDocumentId: async () => [] } as never,
      topicRepo: {} as never,
      digestRepo: digestRepo as never,
      signalRepo: signalRepo as never,
      loadPreviousStories: async () => [
        { label: "Yesterday's coverage", urls: ["https://example1.com/x"] },
      ],
      logger: silentLogger(),
    });

    await svc.generate({ editionId: "ed-1" });

    expect(signalRepo.createBatch).toHaveBeenCalledTimes(1);
    const rows = signalRepo.createBatch.mock.calls[0][0] as CreateSignalInput[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.signal_kind).toBe("claimed_in_top");
      expect(row.edition_id).toBe("ed-1");
      expect(row.source_identity).toBeNull();
      expect(row.source_url).toBeNull();
    }
    expect(rows.map((r) => r.story_id)).toEqual(["s2", "s3"]);
    expect(rows.map((r) => (r.payload as { top_position: number }).top_position)).toEqual([1, 2]);
  });

  it("continues normally when signal insert fails", async () => {
    const stories = makeNStories(2, "Politics", "election");
    const assembledStories = stories.map((s) => makeAssembled(s));
    const signalRepo = {
      createBatch: vi.fn().mockRejectedValue(new Error("db down")),
      getByEdition: vi.fn(),
      getByEditionAndKind: vi.fn(),
      countByEditionAndKind: vi.fn(),
      getBySourceIdentity: vi.fn(),
    };
    const digestRepo = {
      createForEdition: vi.fn().mockResolvedValue({
        id: "md-err",
        edition_id: "ed-1",
        content: "x",
        story_count: 2,
        document_count: 2,
        citation_count: 4,
        created_at: new Date(),
      }),
      getByEdition: vi.fn().mockResolvedValue(undefined),
      deleteByEdition: vi.fn(),
    };
    const editionRepo = {
      getById: vi.fn().mockResolvedValue(makeEdition()),
      getByDate: vi.fn(),
    };
    const storySummaryRepo = {
      getByStoryId: vi.fn().mockImplementation(async (storyId: string) => {
        const snap = stories.find((s) => s.storyId === storyId)!;
        return {
          id: `sum-${storyId}`,
          story_id: storyId,
          content: snap.summaryText,
          prompt_id: "p1",
          prompt_version: 1,
          model: "fake",
          provider: "fake",
          input_hash: "h",
          created_at: new Date(),
        };
      }),
      getCitationsBySummaryId: vi.fn().mockImplementation(async (summaryId: string) => {
        const storyId = summaryId.replace(/^sum-/, "");
        const snap = stories.find((s) => s.storyId === storyId)!;
        return snap.claims.map((c, i) => ({
          id: `cit-${storyId}-${i}`,
          story_summary_id: summaryId,
          chunk_id: c.chunkId,
          claim_text: c.text,
          claim_order: i,
          created_at: new Date(),
        }));
      }),
      replaceForStory: vi.fn(),
      deleteByStoryId: vi.fn(),
    };
    const docRepo = {
      getById: vi.fn().mockImplementation(async (documentId: string) => {
        const snap = stories.flatMap((s) => s.documents).find((d) => d.id === documentId);
        if (!snap) return undefined;
        return {
          id: snap.id,
          edition_id: "ed-1",
          source_type: snap.sourceType,
          source_url: snap.sourceUrl,
          canonical_url: snap.canonicalUrl,
          title: snap.title,
          subtitle: null,
          authors: [],
          publisher: snap.publisher,
          published_at: null,
          language: "en",
          content_markdown: null,
          content_text: null,
          metadata: {},
          created_at: new Date(),
        };
      }),
      getByEdition: vi.fn().mockResolvedValue([]),
      getByEditionAndUrl: vi.fn(),
      create: vi.fn(),
    };
    const assembly = {
      assemble: vi.fn().mockResolvedValue({
        edition: makeEdition(),
        stories: assembledStories,
        ...DUMMY_ASSEMBLY,
        totalDocuments: 2,
        fullyEnrichedDocuments: 2,
        storiesWithSummaries: 2,
      }),
      collectStories: vi.fn().mockResolvedValue(assembledStories),
      getReadiness: vi.fn(),
      isEditionReady: vi.fn(),
    };
    const svc = createMarkdownDigestService({
      db: {} as never,
      editionRepo: editionRepo as never,
      assembly: assembly as never,
      storySummaryRepo: storySummaryRepo as never,
      docRepo: docRepo as never,
      chunkRepo: { getByDocumentId: async () => [] } as never,
      topicRepo: {} as never,
      digestRepo: digestRepo as never,
      signalRepo: signalRepo as never,
      logger: silentLogger(),
    });

    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(false);
    expect(result.digestId).toBe("md-err");
    expect(digestRepo.createForEdition).toHaveBeenCalledOnce();
  });
});

function emptyBiasView(): BiasView {
  return {
    storyBias: new Map(),
    sourceBias: new Map(),
    mutedSourceIdentities: new Set(),
  };
}

function buildGenerateHarness(args: {
  stories: StorySnapshot[];
  biasEnabled?: boolean;
  biasView?: BiasView;
}) {
  const stories = args.stories;
  const allCitations = stories.flatMap((s) =>
    s.claims.map((c) => ({ chunkId: c.chunkId, claimText: c.text })),
  );
  const citationIndex = buildCitationIndex(allCitations);
  const assembledStories = stories.map((s) => makeAssembled(s));
  const digestRepo = {
    createForEdition: vi.fn().mockResolvedValue({
      id: "md-bias",
      edition_id: "ed-1",
      content: "x",
      story_count: stories.length,
      document_count: stories.reduce((n, s) => n + s.documents.length, 0),
      citation_count: citationIndex.entries.length,
      created_at: new Date(),
    }),
    getByEdition: vi.fn().mockResolvedValue(undefined),
    deleteByEdition: vi.fn(),
  };
  const editionRepo = {
    getById: vi.fn().mockResolvedValue(makeEdition()),
    getByDate: vi.fn(),
  };
  const storySummaryRepo = {
    getByStoryId: vi.fn().mockImplementation(async (storyId: string) => {
      const snap = stories.find((s) => s.storyId === storyId)!;
      return {
        id: `sum-${storyId}`,
        story_id: storyId,
        content: snap.summaryText,
        prompt_id: "p1",
        prompt_version: 1,
        model: "fake",
        provider: "fake",
        input_hash: "h",
        created_at: new Date(),
      };
    }),
    getCitationsBySummaryId: vi.fn().mockImplementation(
      async (summaryId: string) => {
        const storyId = summaryId.replace(/^sum-/, "");
        const snap = stories.find((s) => s.storyId === storyId)!;
        return snap.claims.map((c, i) => ({
          id: `cit-${storyId}-${i}`,
          story_summary_id: summaryId,
          chunk_id: c.chunkId,
          claim_text: c.text,
          claim_order: i,
          created_at: new Date(),
        }));
      },
    ),
    replaceForStory: vi.fn(),
    deleteByStoryId: vi.fn(),
  };
  const docRepo = {
    getById: vi.fn().mockImplementation(async (documentId: string) => {
      const snap = stories
        .flatMap((s) => s.documents)
        .find((d) => d.id === documentId);
      if (!snap) return undefined;
      return {
        id: snap.id,
        edition_id: "ed-1",
        source_type: snap.sourceType,
        source_url: snap.sourceUrl,
        canonical_url: snap.canonicalUrl,
        title: snap.title,
        subtitle: null,
        authors: [],
        publisher: snap.publisher,
        published_at: null,
        language: "en",
        content_markdown: null,
        content_text: null,
        metadata: {},
        created_at: new Date(),
      };
    }),
    getByEdition: vi.fn().mockResolvedValue([]),
    getByEditionAndUrl: vi.fn(),
    create: vi.fn(),
  };
  const assembly = {
    assemble: vi.fn().mockResolvedValue({
      edition: makeEdition(),
      stories: assembledStories,
      ...DUMMY_ASSEMBLY,
      totalDocuments: stories.reduce((n, s) => n + s.documents.length, 0),
      fullyEnrichedDocuments: stories.reduce((n, s) => n + s.documents.length, 0),
      storiesWithSummaries: stories.length,
    }),
    collectStories: vi.fn().mockResolvedValue(assembledStories),
    getReadiness: vi.fn(),
    isEditionReady: vi.fn(),
  };
  const svc = createMarkdownDigestService({
    db: {} as never,
    editionRepo: editionRepo as never,
    assembly: assembly as never,
    storySummaryRepo: storySummaryRepo as never,
    docRepo: docRepo as never,
    chunkRepo: { getByDocumentId: async () => [] } as never,
    topicRepo: {} as never,
    digestRepo: digestRepo as never,
    signalRepo: { createBatch: vi.fn().mockResolvedValue([]) } as never,
    biasEnabled: args.biasEnabled,
    logger: silentLogger(),
  });
  return { svc, digestRepo };
}

describe("bias phase C", () => {
  beforeEach(() => {
    vi.mocked(getBiasView).mockReset();
  });

  it("does not query the bias view when biasEnabled is false (default)", async () => {
    const stories = makeNStories(2, "Technology", "ai");
    const { svc } = buildGenerateHarness({ stories });
    await svc.generate({ editionId: "ed-1" });
    expect(vi.mocked(getBiasView)).not.toHaveBeenCalled();
  });

  it("queries the bias view when biasEnabled is true and produces a digest when no signals are present", async () => {
    const stories = makeNStories(2, "Technology", "ai");
    const { svc, digestRepo } = buildGenerateHarness({
      stories,
      biasEnabled: true,
      biasView: emptyBiasView(),
    });
    vi.mocked(getBiasView).mockResolvedValue(emptyBiasView());
    const result = await svc.generate({ editionId: "ed-1" });
    expect(vi.mocked(getBiasView)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getBiasView)).toHaveBeenCalledWith({}, "ed-1");
    expect(result.storyCount).toBe(2);
    const content = digestRepo.createForEdition.mock.calls[0]![0]!.content;
    expect(content).toContain("### [Ai story 1]");
    expect(content).toContain("### [Ai story 2]");
  });

  it("drops a story whose every document is from a muted source", async () => {
    const mutedStory = makeStoryAt("muted-1", 0, "Technology", "ai", {
      sourceType: "article",
      url: "https://mutedsite.com/x",
    });
    const keptStoryA = makeStoryAt("kept-a", 1, "Politics", "election", {
      sourceType: "article",
      url: "https://newssite-a.com/x",
    });
    const keptStoryB = makeStoryAt("kept-b", 2, "Politics", "election", {
      sourceType: "article",
      url: "https://newssite-b.com/x",
    });
    const stories = [mutedStory, keptStoryA, keptStoryB];
    const biasView: BiasView = {
      storyBias: new Map(),
      sourceBias: new Map([
        ["mutedsite.com", { source_identity: "mutedsite.com", muted: true, mute_count: 1 }],
      ]),
      mutedSourceIdentities: new Set(["mutedsite.com"]),
    };
    const { svc, digestRepo } = buildGenerateHarness({
      stories,
      biasEnabled: true,
      biasView,
    });
    vi.mocked(getBiasView).mockResolvedValue(biasView);
    await svc.generate({ editionId: "ed-1" });
    const content = digestRepo.createForEdition.mock.calls[0]![0]!.content;
    expect(content).toContain("### [Politics: election story kept-a]");
    expect(content).toContain("### [Politics: election story kept-b]");
    expect(content).toContain("suppressed 1 story");
    expect(content).not.toContain("### [Technology: ai story muted-1]");
    expect(content).toContain("[ai headline muted-1](https://mutedsite.com/x)");
  });

  it("omits suppression from coverage when bias removes no stories", async () => {
    const stories = makeNStories(2, "Technology", "ai");
    const { svc, digestRepo } = buildGenerateHarness({
      stories,
      biasEnabled: true,
      biasView: emptyBiasView(),
    });
    vi.mocked(getBiasView).mockResolvedValue(emptyBiasView());
    await svc.generate({ editionId: "ed-1" });
    const content = digestRepo.createForEdition.mock.calls[0]![0]!.content;
    expect(content).not.toMatch(/suppressed \d+ stor/);
  });

  it("moves a down-rated story out of Top Stories into More Stories", async () => {
    const stories: StorySnapshot[] = [];
    for (let i = 1; i <= 51; i++) {
      stories.push(
        makeStoryAt(
          `downrated-${i}`,
          i - 1,
          "Technology",
          "ai",
          { sourceType: "article", url: `https://bias${i}.com/x` },
        ),
      );
    }
    const biasView: BiasView = {
      storyBias: new Map([
        [
          "downrated-1",
          { story_id: "downrated-1", up_votes: 0, down_votes: 1, net_score: -1 },
        ],
      ]),
      sourceBias: new Map(),
      mutedSourceIdentities: new Set(),
    };
    const { svc, digestRepo } = buildGenerateHarness({
      stories,
      biasEnabled: true,
      biasView,
    });
    vi.mocked(getBiasView).mockResolvedValue(biasView);
    await svc.generate({ editionId: "ed-1" });
    const content = digestRepo.createForEdition.mock.calls[0]![0]!.content;
    const topIdx = content.indexOf("## Top Stories");
    const moreIdx = content.indexOf("## More Stories\n");
    expect(topIdx).toBeGreaterThan(-1);
    expect(moreIdx).toBeGreaterThan(topIdx);
    const topSection = content.slice(topIdx, moreIdx);
    expect(topSection).not.toContain("### [Technology: ai story downrated-1]");
    expect(topSection).not.toContain("bias1.com/x");
    expect(topSection).toContain("### [Technology: ai story downrated-2]");
    expect(topSection).toContain("### [Technology: ai story downrated-51]");
    const moreSection = content.slice(moreIdx);
    expect(moreSection).toContain("### [Technology: ai story downrated-1]");
    expect(content).toContain("bias1.com/x");
  });
});

describe("DIGEST_CATEGORY_ORDER", () => {
  it("matches the §43 digest sections", () => {
    expect([...DIGEST_CATEGORY_ORDER]).toEqual([
      "Technology",
      "Politics",
      "Science",
      "Business",
      "Interesting Reads",
      "Videos",
      "Reddit Discussions",
    ]);
  });
});

interface MakeOptions {
  sourceType?: string;
  url?: string;
}

function makeStoryAt(
  storyId: string,
  clusterOrder: number,
  category: string,
  keyword: string,
  opts: MakeOptions = {},
): StorySnapshot {
  const url = opts.url ?? `https://example.com/${storyId}`;
  const sourceType = opts.sourceType ?? "article";
  const chunkId = `chunk-${storyId}`;
  const labelTopic = keyword ? `${category}: ${keyword} story ${storyId}` : `${category} story ${storyId}`;
  const docTopic = keyword ? `${keyword} headline ${storyId}` : `Doc ${storyId}`;
  return {
    storyId,
    storyLabel: labelTopic,
    clusterOrder,
    summaryText: `Summary text for ${keyword || category} story ${storyId}. It makes a claim.`,
    claims: [{ text: `Story ${storyId} asserts something important.`, chunkId }],
    documents: [
      {
        id: `doc-${storyId}`,
        title: docTopic,
        sourceUrl: url,
        canonicalUrl: url,
        sourceType,
        publisher: null,
      chunkIds: [],
      },
    ],
  };
}

function makeNStories(n: number, _category: string, keyword: string): StorySnapshot[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `s${i + 1}`;
    const sourceType = i % 2 === 0 ? "article" : "article";
    return {
      storyId: id,
      storyLabel: capitalize(keyword) + ` story ${i + 1}`,
      clusterOrder: i,
      summaryText: `Lead sentence about ${keyword}. A second sentence adds detail.`,
      claims: [
        { text: `Claim ${i + 1} about ${keyword}.`, chunkId: `${id}-c1` },
        { text: `Second claim ${i + 1}.`, chunkId: `${id}-c2` },
      ],
      documents: [
        {
          id: `doc-${id}`,
          title: `Doc ${i + 1}`,
          sourceUrl: `https://example${i + 1}.com/x`,
          canonicalUrl: `https://example${i + 1}.com/x`,
          sourceType,
          publisher: null,
        chunkIds: [],
        },
      ],
    };
  });
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function makeAssembled(snap: StorySnapshot) {
  return {
    story: {
      id: snap.storyId,
      edition_id: "ed-1",
      label: snap.storyLabel,
      cluster_order: snap.clusterOrder,
      created_at: new Date(),
      updated_at: new Date(),
    },
    members: snap.documents.map((d) => ({
      id: `m-${snap.storyId}-${d.id}`,
      story_id: snap.storyId,
      document_id: d.id,
      role: "supporting",
      similarity: 0,
      created_at: new Date(),
    })),
    hasSummary: true,
    summaryId: `sum-${snap.storyId}`,
  };
}
