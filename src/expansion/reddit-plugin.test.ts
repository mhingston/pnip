import { describe, it, expect, vi } from "vitest";
import {
  createRedditPlugin,
  extractArticleId,
  isRedditUrl,
  toRssUrl,
  parseAtomFeed,
  buildRedditSections,
  type RssFetcher,
  type RedditThread,
} from "./reddit-plugin.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";
import type { ExpandContext } from "./types.js";

const SUBMISSION_URL = "https://www.reddit.com/r/Sub/comments/1up7bmj/slug/";

const FAKE_ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Submission Title : SubredditName</title>
  <entry>
    <id>t3_1up7bmj</id>
    <title>Submission Title</title>
    <author><name>/u/authorname</name><uri>https://www.reddit.com/user/authorname</uri></author>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Body text with &lt;a href="https://example.com"&gt;a link&lt;/a&gt; and &lt;strong&gt;bold&lt;/strong&gt;.&lt;/p&gt;&lt;/div&gt; submitted by &lt;a href="https://www.reddit.com/user/authorname"&gt;/u/authorname&lt;/a&gt;</content>
    <updated>2026-07-06T19:20:00+00:00</updated>
    <published>2026-07-06T19:20:00+00:00</published>
    <link href="https://www.reddit.com/r/Sub/comments/1up7bmj/slug/" />
    <category term="SubredditName" />
  </entry>
  <entry>
    <id>t1_ovxudrw</id>
    <title>/u/Flimsy_Meal_4199 on Submission Title</title>
    <author><name>/u/Flimsy_Meal_4199</name><uri>https://www.reddit.com/user/Flimsy_Meal_4199</uri></author>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Comment text &lt;em&gt;italic&lt;/em&gt;.&lt;/p&gt;&lt;/div&gt;</content>
    <updated>2026-07-06T19:27:58+00:00</updated>
    <link href="https://www.reddit.com/r/Sub/comments/1up7bmj/slug/ovxudrw/" />
    <category term="SubredditName" />
  </entry>
  <entry>
    <id>t1_deleted1</id>
    <title>/u/deleteduser on Submission Title</title>
    <author><name>/u/deleteduser</name><uri>https://www.reddit.com/user/deleteduser</uri></author>
    <content type="html"></content>
    <updated>2026-07-06T19:30:00+00:00</updated>
    <link href="https://www.reddit.com/r/Sub/comments/1up7bmj/slug/deleted1/" />
    <category term="SubredditName" />
  </entry>
  <entry>
    <id>t1_abcdef1</id>
    <title>/u/second on Submission Title</title>
    <author><name>/u/second</name><uri>https://www.reddit.com/user/second</uri></author>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Second comment.&lt;/p&gt;&lt;/div&gt;</content>
    <updated>2026-07-06T19:35:00+00:00</updated>
    <link href="https://www.reddit.com/r/Sub/comments/1up7bmj/slug/abcdef1/" />
    <category term="SubredditName" />
  </entry>
</feed>`;

const ctx: ExpandContext = {
  url: SUBMISSION_URL,
  editionId: "e1",
  discoveryEventId: "d1",
};

describe("isRedditUrl", () => {
  it("matches www.reddit.com comment URLs", () => {
    expect(isRedditUrl("https://www.reddit.com/r/Anthropic/comments/1upftp9/title/")).toBe(true);
  });

  it("matches old.reddit.com comment URLs", () => {
    expect(isRedditUrl("https://old.reddit.com/r/test/comments/abc123/")).toBe(true);
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
      extractArticleId("https://www.reddit.com/r/Anthropic/comments/1upftp9/report_anthropic/"),
    ).toBe("1upftp9");
  });

  it("returns undefined for non-reddit URLs", () => {
    expect(extractArticleId("https://example.com")).toBeUndefined();
  });
});

describe("toRssUrl", () => {
  it("appends .rss to a URL with trailing slash", () => {
    expect(toRssUrl("https://www.reddit.com/r/Sub/comments/ID/slug/")).toBe(
      "https://www.reddit.com/r/Sub/comments/ID/slug/.rss",
    );
  });

  it("adds a slash then .rss when no trailing slash", () => {
    expect(toRssUrl("https://www.reddit.com/r/Sub/comments/ID/slug")).toBe(
      "https://www.reddit.com/r/Sub/comments/ID/slug/.rss",
    );
  });

  it("strips query params before appending .rss", () => {
    expect(toRssUrl("https://www.reddit.com/r/Sub/comments/ID/slug/?ref=home")).toBe(
      "https://www.reddit.com/r/Sub/comments/ID/slug/.rss",
    );
  });
});

describe("parseAtomFeed", () => {
  it("extracts submission and comments, stripping HTML, prefixes, and skipping deleted", () => {
    const thread = parseAtomFeed(FAKE_ATOM_XML);
    expect(thread.submission.id).toBe("1up7bmj");
    expect(thread.submission.title).toBe("Submission Title");
    expect(thread.submission.author).toBe("authorname");
    expect(thread.submission.subreddit).toBe("SubredditName");
    expect(thread.submission.url).toBe(SUBMISSION_URL);
    expect(thread.submission.createdUtc).toEqual(new Date("2026-07-06T19:20:00+00:00"));
    expect(thread.submission.selftext).toContain("Body text");
    expect(thread.submission.selftext).toContain("[a link](https://example.com)");
    expect(thread.submission.selftext).toContain("**bold**");
    expect(thread.submission.selftext).not.toContain("submitted by");

    expect(thread.comments).toHaveLength(2);
    const [c1, c2] = thread.comments;
    expect(c1.id).toBe("ovxudrw");
    expect(c1.author).toBe("Flimsy_Meal_4199");
    expect(c1.body).toContain("Comment text");
    expect(c1.body).toContain("*italic*");
    expect(c1.createdUtc).toEqual(new Date("2026-07-06T19:27:58+00:00"));
    expect(c2.id).toBe("abcdef1");
    expect(c2.author).toBe("second");
  });
});

describe("buildRedditSections", () => {
  it("produces submission + comment sections, skipping deleted, no score in heading", () => {
    const thread = parseAtomFeed(FAKE_ATOM_XML);
    const sections = buildRedditSections(thread);
    expect(sections.length).toBe(3);
    expect(sections[0].section_type).toBe("reddit_submission");
    expect(sections[0].order).toBe(0);
    expect(sections[0].heading).toBe("Submission Title");
    expect(sections[1].section_type).toBe("reddit_comment");
    expect(sections[1].order).toBe(1);
    expect(sections[1].heading).toBe("u/Flimsy_Meal_4199");
    expect(sections[2].heading).toBe("u/second");
  });
});

describe("createRedditPlugin.supports", () => {
  const plugin = createRedditPlugin({ fetcher: vi.fn() });

  it("matches reddit comment URLs", () => {
    expect(plugin.supports("https://www.reddit.com/r/Anthropic/comments/1upftp9/title/")).toBe(true);
  });

  it("rejects non-reddit URLs", () => {
    expect(plugin.supports("https://example.com/article")).toBe(false);
  });
});

describe("createRedditPlugin.expand", () => {
  it("returns a canonical ExpandResult using an injected fake fetcher", async () => {
    const fetcher: RssFetcher = vi.fn().mockResolvedValue(FAKE_ATOM_XML);
    const plugin = createRedditPlugin({ fetcher });

    const result = await plugin.expand(ctx);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://www.reddit.com/r/Sub/comments/1up7bmj/slug/.rss",
    );
    expect(result.title).toBe("Submission Title");
    expect(result.sourceType).toBe("reddit");
    expect(result.canonicalUrl).toBe(SUBMISSION_URL);
    expect(result.authors).toEqual(["authorname"]);
    expect(result.publishedAt).toEqual(new Date("2026-07-06T19:20:00+00:00"));
    expect(result.sections[0].section_type).toBe("reddit_submission");
    expect(result.sections[1].section_type).toBe("reddit_comment");
    expect((result.metadata as Record<string, unknown>).articleId).toBe("1up7bmj");
    expect((result.metadata as Record<string, unknown>).subreddit).toBe("SubredditName");
  });

  it("throws when the URL is not a Reddit comments URL", async () => {
    const fetcher: RssFetcher = vi.fn();
    const plugin = createRedditPlugin({ fetcher });
    const badCtx: ExpandContext = {
      url: "https://example.com/article",
      editionId: "e1",
      discoveryEventId: "d1",
    };
    await expect(plugin.expand(badCtx)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates RedditRateLimitError from the fetcher", async () => {
    const fetcher: RssFetcher = vi.fn().mockRejectedValue(new RedditRateLimitError(45));
    const plugin = createRedditPlugin({ fetcher });
    await expect(plugin.expand(ctx)).rejects.toMatchObject({
      name: "RedditRateLimitError",
      resetSeconds: 45,
    });
  });
});
