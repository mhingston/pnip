import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRedditPlugin,
  extractArticleId,
  isRedditUrl,
  parseSubmission,
  parseComment,
  parseThread,
  buildRedditSections,
  type RedditFetcher,
  type RedditSubmission,
  type RedditComment,
  type RedditThread,
} from "./reddit-plugin.js";
import { resetConfigCache } from "../config/index.js";
import type { ExpandContext } from "./types.js";

const SUBMISSION_T3_DATA = {
  id: "1upftp9",
  name: "t3_1upftp9",
  title: "Report: Anthropic is reportedly locking Claude",
  selftext: "Body text of the submission.",
  selftext_html: "<p>Body text of the submission.</p>",
  author: "username",
  subreddit: "Anthropic",
  subreddit_name_prefixed: "r/Anthropic",
  score: 1234,
  num_comments: 567,
  upvote_ratio: 0.95,
  created_utc: 1735900000.0,
  url: "https://example.com/article",
  permalink: "/r/Anthropic/comments/1upftp9/report_anthropic/",
  is_self: false,
  link_flair_text: "Discussion",
  stickied: false,
  over_18: false,
  thumbnail: "",
  preview: {},
};

const COMMENT_T1_DATA = {
  id: "comment1",
  author: "commenter1",
  body: "Comment text.",
  body_html: "<p>Comment text.</p>",
  score: 45,
  created_utc: 1735900100.0,
  stickied: false,
  is_submitter: false,
  distinguished: null,
  replies: {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t1",
          data: {
            id: "comment1a",
            author: "commenter1a",
            body: "Nested reply.",
            body_html: "<p>Nested reply.</p>",
            score: 5,
            created_utc: 1735900200.0,
            stickied: false,
            is_submitter: true,
            distinguished: null,
            replies: "",
          },
        },
        {
          kind: "more",
          data: { count: 2, children: ["c2", "c3"] },
        },
      ],
    },
  },
};

const DELETED_COMMENT_T1_DATA = {
  id: "comment_deleted",
  author: "[deleted]",
  body: "[deleted]",
  body_html: "",
  score: 0,
  created_utc: 1735900300.0,
  stickied: false,
  is_submitter: false,
  distinguished: null,
  replies: "",
};

const PLAIN_COMMENT_T1_DATA = {
  id: "comment2",
  author: "commenter2",
  body: "Another top-level comment.",
  body_html: "<p>Another top-level comment.</p>",
  score: 12,
  created_utc: 1735900400.0,
  stickied: false,
  is_submitter: false,
  distinguished: null,
  replies: "",
};

const FAKE_API_RESPONSE = [
  {
    kind: "Listing",
    data: {
      children: [{ kind: "t3", data: SUBMISSION_T3_DATA }],
    },
  },
  {
    kind: "Listing",
    data: {
      children: [
        { kind: "t1", data: COMMENT_T1_DATA },
        { kind: "t1", data: DELETED_COMMENT_T1_DATA },
        { kind: "t1", data: PLAIN_COMMENT_T1_DATA },
      ],
    },
  },
];

const ctx: ExpandContext = {
  url: "https://www.reddit.com/r/Anthropic/comments/1upftp9/report_anthropic/",
  editionId: "e1",
  discoveryEventId: "d1",
};

describe("isRedditUrl", () => {
  it("matches www.reddit.com comment URLs", () => {
    expect(
      isRedditUrl("https://www.reddit.com/r/Anthropic/comments/1upftp9/title/"),
    ).toBe(true);
  });

  it("matches old.reddit.com comment URLs", () => {
    expect(isRedditUrl("https://old.reddit.com/r/test/comments/abc123/")).toBe(
      true,
    );
  });

  it("rejects non-reddit hosts", () => {
    expect(isRedditUrl("https://example.com/article")).toBe(false);
  });

  it("rejects reddit URLs without /comments/", () => {
    expect(isRedditUrl("https://www.reddit.com/r/Anthropic")).toBe(false);
  });
});

describe("extractArticleId", () => {
  it("extracts the article id from a www.reddit.com URL", () => {
    expect(
      extractArticleId(
        "https://www.reddit.com/r/Anthropic/comments/1upftp9/report_anthropic/",
      ),
    ).toBe("1upftp9");
  });

  it("extracts the article id from an old.reddit.com URL", () => {
    expect(
      extractArticleId("https://old.reddit.com/r/test/comments/abc123/title/"),
    ).toBe("abc123");
  });

  it("returns undefined for non-reddit URLs", () => {
    expect(extractArticleId("https://example.com")).toBeUndefined();
  });
});

describe("parseSubmission", () => {
  it("maps the t3 data object to a RedditSubmission with Date createdAt", () => {
    const sub = parseSubmission(SUBMISSION_T3_DATA);
    expect(sub.id).toBe("1upftp9");
    expect(sub.title).toBe("Report: Anthropic is reportedly locking Claude");
    expect(sub.selftext).toBe("Body text of the submission.");
    expect(sub.author).toBe("username");
    expect(sub.subreddit).toBe("Anthropic");
    expect(sub.score).toBe(1234);
    expect(sub.numComments).toBe(567);
    expect(sub.upvoteRatio).toBe(0.95);
    expect(sub.createdUtc).toEqual(new Date(1735900000 * 1000));
    expect(sub.url).toBe("https://example.com/article");
    expect(sub.permalink).toBe("/r/Anthropic/comments/1upftp9/report_anthropic/");
    expect(sub.isSelf).toBe(false);
    expect(sub.flairText).toBe("Discussion");
    expect(sub.stickied).toBe(false);
    expect(sub.over18).toBe(false);
  });
});

describe("parseComment", () => {
  it("parses a t1 data object with nested replies, skipping 'more' children", () => {
    const comment = parseComment(COMMENT_T1_DATA);
    expect(comment.id).toBe("comment1");
    expect(comment.author).toBe("commenter1");
    expect(comment.body).toBe("Comment text.");
    expect(comment.score).toBe(45);
    expect(comment.createdUtc).toEqual(new Date(1735900100 * 1000));
    expect(comment.stickied).toBe(false);
    expect(comment.isSubmitter).toBe(false);
    expect(comment.distinguished).toBeNull();
    expect(comment.replies.length).toBe(1);
    expect(comment.replies[0].id).toBe("comment1a");
    expect(comment.replies[0].author).toBe("commenter1a");
    expect(comment.replies[0].isSubmitter).toBe(true);
  });

  it("parses a deleted comment without filtering (filtering is the section builder's job)", () => {
    const comment = parseComment(DELETED_COMMENT_T1_DATA);
    expect(comment.id).toBe("comment_deleted");
    expect(comment.body).toBe("[deleted]");
    expect(comment.replies).toEqual([]);
  });
});

describe("parseThread", () => {
  it("returns { submission, comments } from the Reddit API response array", () => {
    const thread = parseThread(FAKE_API_RESPONSE);
    expect(thread.submission.id).toBe("1upftp9");
    expect(thread.comments.length).toBe(3);
    expect(thread.comments[0].id).toBe("comment1");
    expect(thread.comments[1].id).toBe("comment_deleted");
    expect(thread.comments[2].id).toBe("comment2");
  });
});

describe("buildRedditSections", () => {
  it("produces 1 submission section + N comment sections, skipping deleted", () => {
    const thread: RedditThread = {
      submission: parseSubmission(SUBMISSION_T3_DATA),
      comments: [
        parseComment(COMMENT_T1_DATA),
        parseComment(DELETED_COMMENT_T1_DATA),
        parseComment(PLAIN_COMMENT_T1_DATA),
      ],
    };
    const sections = buildRedditSections(thread);
    expect(sections.length).toBe(3);
    expect(sections[0].section_type).toBe("reddit_submission");
    expect(sections[0].order).toBe(0);
    expect(sections[0].heading).toBe(thread.submission.title);
    expect(sections[1].section_type).toBe("reddit_comment");
    expect(sections[1].order).toBe(1);
    expect(sections[1].heading).toBe("u/commenter1 (score: 45)");
    expect(sections[2].section_type).toBe("reddit_comment");
    expect(sections[2].order).toBe(2);
    expect(sections[2].heading).toBe("u/commenter2 (score: 12)");
  });

  it("produces just the submission section when there are no comments", () => {
    const thread: RedditThread = {
      submission: parseSubmission(SUBMISSION_T3_DATA),
      comments: [],
    };
    const sections = buildRedditSections(thread);
    expect(sections.length).toBe(1);
    expect(sections[0].section_type).toBe("reddit_submission");
  });
});

describe("createRedditPlugin.supports", () => {
  const plugin = createRedditPlugin({ fetcher: vi.fn() });

  it("matches reddit comment URLs", () => {
    expect(
      plugin.supports(
        "https://www.reddit.com/r/Anthropic/comments/1upftp9/title/",
      ),
    ).toBe(true);
  });

  it("rejects non-reddit URLs", () => {
    expect(plugin.supports("https://example.com/article")).toBe(false);
  });
});

describe("createRedditPlugin.expand", () => {
  const originalEnv: NodeJS.ProcessEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    resetConfigCache();
  });

  it("returns a canonical ExpandResult using an injected fake fetcher", async () => {
    const fetcher: RedditFetcher = vi.fn().mockResolvedValue(FAKE_API_RESPONSE);
    const plugin = createRedditPlugin({ fetcher });

    const result = await plugin.expand(ctx);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain("https://oauth.reddit.com/comments/1upftp9");
    expect(
      (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain("limit=10");
    expect(
      (fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain("sort=top");
    expect(result.title).toBe("Report: Anthropic is reportedly locking Claude");
    expect(result.sourceType).toBe("reddit");
    expect(result.canonicalUrl).toBe(
      "https://www.reddit.com/r/Anthropic/comments/1upftp9/report_anthropic/",
    );
    expect(result.authors).toEqual(["username"]);
    expect(result.publishedAt).toBeInstanceOf(Date);
    expect(result.sections[0].section_type).toBe("reddit_submission");
    expect((result.metadata as Record<string, unknown>).articleId).toBe(
      "1upftp9",
    );
    expect((result.metadata as Record<string, unknown>).subreddit).toBe(
      "Anthropic",
    );
    expect((result.metadata as Record<string, unknown>).score).toBe(1234);
  });

  it("throws when the URL is not a Reddit comments URL", async () => {
    const fetcher: RedditFetcher = vi.fn();
    const plugin = createRedditPlugin({ fetcher });
    const badCtx: ExpandContext = {
      url: "https://example.com/article",
      editionId: "e1",
      discoveryEventId: "d1",
    };
    await expect(plugin.expand(badCtx)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates errors from the fetcher", async () => {
    const fetcher: RedditFetcher = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    const plugin = createRedditPlugin({ fetcher });
    await expect(plugin.expand(ctx)).rejects.toThrow(/network down/);
  });

  it("throws when no fetcher is injected and Reddit creds are missing", async () => {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_USER_AGENT;
    resetConfigCache();
    const plugin = createRedditPlugin();
    await expect(plugin.expand(ctx)).rejects.toThrow(
      /Reddit credentials not configured/,
    );
  });
});
