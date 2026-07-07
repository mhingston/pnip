import { describe, it, expect, vi } from "vitest";
import {
  createRefreshRedditCommentsWorker,
  REFRESH_DELAYS_MS,
} from "./refresh-reddit-comments-worker.js";
import type { RssFetcher } from "./reddit-plugin.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";
import type { SectionRepository, DocumentSectionRow } from "./section-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { ProcessingJob } from "../database/kysely.js";

const ARTICLE_ID = "1upftp9";
const URL = "https://www.reddit.com/r/test/comments/1upftp9/title/";

const FAKE_ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>t3_${ARTICLE_ID}</id>
    <title>Test Submission</title>
    <author><name>/u/submitter</name></author>
    <content type="html">&lt;p&gt;submission body&lt;/p&gt;</content>
    <updated>2026-07-06T19:20:00+00:00</updated>
    <published>2026-07-06T19:20:00+00:00</published>
    <link href="${URL}" />
    <category term="test" />
  </entry>
  <entry>
    <id>t1_c1</id>
    <author><name>/u/u-c1</name></author>
    <content type="html">&lt;p&gt;body c1&lt;/p&gt;</content>
    <updated>2026-07-06T19:27:58+00:00</updated>
  </entry>
  <entry>
    <id>t1_c2</id>
    <author><name>/u/u-c2</name></author>
    <content type="html">&lt;p&gt;body c2&lt;/p&gt;</content>
    <updated>2026-07-06T19:28:00+00:00</updated>
  </entry>
  <entry>
    <id>t1_c3</id>
    <author><name>/u/u-c3</name></author>
    <content type="html">&lt;p&gt;body c3&lt;/p&gt;</content>
    <updated>2026-07-06T19:29:00+00:00</updated>
  </entry>
</feed>`;

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "refresh_reddit_comments",
    edition_id: "edition-1",
    target: {
      documentId: "doc-1",
      articleId: ARTICLE_ID,
      url: URL,
      refreshStep: 0,
    },
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

function fakeSection(redditCommentId: string, order: number): DocumentSectionRow {
  return {
    id: `sec-${redditCommentId}`,
    document_id: "doc-1",
    section_order: order,
    heading: `u/x`,
    section_type: "reddit_comment",
    content_markdown: "old",
    content_text: "old",
    metadata: { redditCommentId },
    created_at: new Date(),
  };
}

function makeDeps(overrides?: {
  fetcher?: RssFetcher;
  existingSections?: DocumentSectionRow[];
  editionStatus?: string;
  maxOrder?: number;
}) {
  const fetcher: RssFetcher =
    overrides?.fetcher ?? (vi.fn().mockResolvedValue(FAKE_ATOM_XML) as RssFetcher);
  const sectionRepo: SectionRepository = {
    createBatch: vi.fn().mockResolvedValue([]),
    getByDocumentId: vi.fn(),
    getMaxOrder: vi.fn().mockResolvedValue(overrides?.maxOrder ?? 5),
    getByDocumentIdAndType: vi
      .fn()
      .mockResolvedValue(overrides?.existingSections ?? []),
  };
  const editionRepo: EditionRepository = {
    create: vi.fn(),
    getById: vi.fn().mockResolvedValue({
      id: "edition-1",
      status: overrides?.editionStatus ?? "building",
    }),
    getByDate: vi.fn(),
    getOrCreateForDate: vi.fn(),
    transition: vi.fn(),
  };
  const queue: ProcessingJobQueue = {
    enqueue: vi.fn().mockResolvedValue({ id: "next-job" }),
    claim: vi.fn(),
    complete: vi.fn(),
    getJob: vi.fn(),
    recoverStaleJobs: vi.fn(),
    archiveJobs: vi.fn(),
  };
  return { redditFetcher: fetcher, sectionRepo, editionRepo, queue };
}

function fakeCtx() {
  return {
    db: {} as any,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
  };
}

describe("createRefreshRedditCommentsWorker", () => {
  it("supports only refresh_reddit_comments", () => {
    const worker = createRefreshRedditCommentsWorker(makeDeps());
    expect(worker.supports("refresh_reddit_comments")).toBe(true);
    expect(worker.supports("expand_document")).toBe(false);
  });

  it("appends new comments (deduped), continues ordering, enqueues next refresh", async () => {
    const deps = makeDeps({
      existingSections: [fakeSection("c1", 5)],
      maxOrder: 5,
    });
    const worker = createRefreshRedditCommentsWorker(deps);
    const before = Date.now();
    const outcome = await worker.execute(makeJob(), fakeCtx());

    expect(deps.redditFetcher).toHaveBeenCalledTimes(1);
    expect((deps.redditFetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://www.reddit.com/r/test/comments/1upftp9/title/.rss",
    );
    expect(deps.sectionRepo.getByDocumentIdAndType).toHaveBeenCalledWith(
      "doc-1",
      "reddit_comment",
    );
    expect(deps.sectionRepo.getMaxOrder).toHaveBeenCalledWith("doc-1");

    const createArgs = (deps.sectionRepo.createBatch as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(createArgs).toHaveLength(2);
    expect(createArgs[0].order).toBe(6);
    expect(createArgs[1].order).toBe(7);
    expect(createArgs[0].metadata.redditCommentId).toBe("c2");
    expect(createArgs[1].metadata.redditCommentId).toBe("c3");
    expect(createArgs[0].heading).toBe("u/u-c2");
    expect(createArgs[0].type).toBe("reddit_comment");

    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = (deps.queue.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(enqueueArg.jobType).toBe("refresh_reddit_comments");
    expect(enqueueArg.editionId).toBe("edition-1");
    expect(enqueueArg.target).toEqual({
      documentId: "doc-1",
      articleId: ARTICLE_ID,
      url: URL,
      refreshStep: 1,
    });
    expect(enqueueArg.nextEligibleAt).toBeInstanceOf(Date);
    const expectedDelay = REFRESH_DELAYS_MS[1];
    const elapsed = enqueueArg.nextEligibleAt.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(expectedDelay - 1000);
    expect(elapsed).toBeLessThanOrEqual(expectedDelay + 5000);
    expect(outcome).toEqual({});
  });

  it("skips createBatch when all comments already exist but still enqueues next refresh", async () => {
    const deps = makeDeps({
      existingSections: [
        fakeSection("c1", 0),
        fakeSection("c2", 1),
        fakeSection("c3", 2),
      ],
    });
    const worker = createRefreshRedditCommentsWorker(deps);
    await worker.execute(makeJob(), fakeCtx());

    expect(deps.sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = (deps.queue.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(enqueueArg.target.refreshStep).toBe(1);
  });

  it("skips entirely when edition is not in building state", async () => {
    const deps = makeDeps({ editionStatus: "ready" });
    const worker = createRefreshRedditCommentsWorker(deps);
    const outcome = await worker.execute(makeJob(), fakeCtx());

    expect(deps.redditFetcher).not.toHaveBeenCalled();
    expect(deps.sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("does not enqueue a next refresh on the last timed step (refreshStep=2)", async () => {
    const deps = makeDeps({ existingSections: [fakeSection("c1", 5)] });
    const worker = createRefreshRedditCommentsWorker(deps);
    await worker.execute(
      makeJob({
        target: {
          documentId: "doc-1",
          articleId: ARTICLE_ID,
          url: URL,
          refreshStep: 2,
        },
      }),
      fakeCtx(),
    );

    expect(deps.sectionRepo.createBatch).toHaveBeenCalledTimes(1);
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("on RedditRateLimitError re-enqueues the refresh job with delayed nextEligibleAt and returns {}", async () => {
    const deps = makeDeps({
      fetcher: vi.fn().mockRejectedValue(new RedditRateLimitError(60)),
    });
    const worker = createRefreshRedditCommentsWorker(deps);
    const before = Date.now();
    const outcome = await worker.execute(makeJob(), fakeCtx());

    expect(deps.sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    const arg = (deps.queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.jobType).toBe("refresh_reddit_comments");
    expect(arg.target).toEqual({
      documentId: "doc-1",
      articleId: ARTICLE_ID,
      url: URL,
      refreshStep: 0,
    });
    const elapsed = arg.nextEligibleAt.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(60 * 1000 - 1000);
    expect(elapsed).toBeLessThanOrEqual(60 * 1000 + 5000);
    expect(outcome).toEqual({});
  });

  it("throws when the fetcher errors with a non-rate-limit error", async () => {
    const deps = makeDeps({
      fetcher: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const worker = createRefreshRedditCommentsWorker(deps);
    await expect(worker.execute(makeJob(), fakeCtx())).rejects.toThrow(/network down/);
  });

  it("throws when target is missing required fields", async () => {
    const worker = createRefreshRedditCommentsWorker(makeDeps());
    await expect(
      worker.execute(makeJob({ target: null }), fakeCtx()),
    ).rejects.toThrow(/invalid target/i);
  });
});
