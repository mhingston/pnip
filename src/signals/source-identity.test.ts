import { describe, it, expect } from "vitest";
import { deriveSourceIdentity } from "./source-identity.js";

describe("deriveSourceIdentity", () => {
  describe("article", () => {
    it("extracts the hostname and strips leading www.", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.theverge.com/2024/1/15/ai",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("theverge.com");
    });

    it("retains meaningful subdomains", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://blog.openai.com/research/x",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("blog.openai.com");
    });

    it("normalizes an uppercase host to lowercase", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://WWW.TheVerge.com/x",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("theverge.com");
    });

    it("strips the port from the hostname", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://example.com:8080/x",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("example.com");
    });

    it("handles a trailing slash with no path", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://example.com/",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("example.com");
    });
  });

  describe("reddit", () => {
    it("extracts /r/{subreddit} from the path and lowercases the result", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl:
            "https://www.reddit.com/r/MachineLearning/comments/abc/def",
          sourceType: "reddit",
          publisher: null,
          metadata: null,
        }),
      ).toBe("reddit.com/r/machinelearning");
    });

    it("normalizes old.reddit.com to reddit.com", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://old.reddit.com/r/MachineLearning/comments/abc",
          sourceType: "reddit",
          publisher: null,
          metadata: null,
        }),
      ).toBe("reddit.com/r/machinelearning");
    });

    it("extracts /user/{username} from the path", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.reddit.com/user/foo/comments/abc",
          sourceType: "reddit",
          publisher: null,
          metadata: null,
        }),
      ).toBe("reddit.com/user/foo");
    });

    it("matches the /r/ prefix case-insensitively", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.reddit.com/R/MachineLearning/",
          sourceType: "reddit",
          publisher: null,
          metadata: null,
        }),
      ).toBe("reddit.com/r/machinelearning");
    });

    it("falls back to reddit.com when no /r/ or /user/ segment is present", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.reddit.com/",
          sourceType: "reddit",
          publisher: null,
          metadata: null,
        }),
      ).toBe("reddit.com");
    });
  });

  describe("youtube", () => {
    it("derives the channel ID from metadata.author_url (/channel/UC...)", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          sourceType: "youtube",
          publisher: "YouTube",
          metadata: {
            author_url:
              "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
          },
        }),
      ).toBe("youtube.com/channel:UC_x5XG1OV2P6uZZ5FSM9Ttw");
    });

    it("derives the handle from metadata.author_url (/@handle)", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          sourceType: "youtube",
          publisher: "YouTube",
          metadata: { author_url: "https://www.youtube.com/@lexfridman" },
        }),
      ).toBe("youtube.com/@lexfridman");
    });

    it("falls back to metadata.author_name as youtube.com/channel:{name}", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          sourceType: "youtube",
          publisher: "YouTube",
          metadata: { author_name: "Lex Fridman" },
        }),
      ).toBe("youtube.com/channel:Lex Fridman");
    });

    it("falls back to coarse youtube.com when metadata has no author fields", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          sourceType: "youtube",
          publisher: "YouTube",
          metadata: null,
        }),
      ).toBe("youtube.com");
    });

    it("falls through to URL-based derivation when metadata is not a plain object", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://www.youtube.com/watch?v=abc",
          sourceType: "youtube",
          publisher: "YouTube",
          metadata: "not-an-object",
        }),
      ).toBe("youtube.com");
    });
  });

  describe("podcast", () => {
    it("uses podcast:{publisher} (lowercased, trimmed) when publisher is present", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://feeds.example.com/ep123",
          sourceType: "podcast",
          publisher: "The Daily",
          metadata: null,
        }),
      ).toBe("podcast:the daily");
    });

    it("falls back to hostname when publisher is null", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://feeds.example.com/ep123",
          sourceType: "podcast",
          publisher: null,
          metadata: null,
        }),
      ).toBe("feeds.example.com");
    });

    it("falls back to hostname when publisher is an empty string", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://feeds.example.com/ep123",
          sourceType: "podcast",
          publisher: "",
          metadata: null,
        }),
      ).toBe("feeds.example.com");
    });
  });

  describe("pdf", () => {
    it("extracts the hostname like article", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "https://arxiv.org/pdf/2401.12345",
          sourceType: "pdf",
          publisher: null,
          metadata: null,
        }),
      ).toBe("arxiv.org");
    });
  });

  describe("fallback", () => {
    it("returns the raw URL string when it cannot be parsed", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "not a valid url",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBe("not a valid url");
    });

    it("returns null for an empty source URL", () => {
      expect(
        deriveSourceIdentity({
          sourceUrl: "",
          sourceType: "article",
          publisher: null,
          metadata: null,
        }),
      ).toBeNull();
    });
  });
});
