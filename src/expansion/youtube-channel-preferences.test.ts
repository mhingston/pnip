import { describe, expect, it } from "vitest";
import {
  isFocusedYoutubeChannel,
  normalizeYoutubeChannel,
} from "./youtube-channel-preferences.js";

describe("YouTube channel preferences", () => {
  it("normalizes display names, handles, and source identities alike", () => {
    expect(normalizeYoutubeChannel("Lenny's Podcast")).toBe("lennyspodcast");
    expect(normalizeYoutubeChannel("@LennysPodcast")).toBe("lennyspodcast");
    expect(normalizeYoutubeChannel("youtube.com/@LennysPodcast")).toBe(
      "lennyspodcast",
    );
    expect(normalizeYoutubeChannel("youtube.com/channel:Lennys Podcast")).toBe(
      "lennyspodcast",
    );
  });

  it("matches a configured display name against stored author metadata", () => {
    expect(
      isFocusedYoutubeChannel(
        {
          sourceType: "youtube",
          sourceIdentity: "youtube.com/@LennysPodcast",
          metadata: { author_url: "https://www.youtube.com/@LennysPodcast" },
          authors: ["Lenny's Podcast"],
        },
        ["Lenny's Podcast"],
      ),
    ).toBe(true);
  });

  it("accepts JSON-encoded authors and rejects non-YouTube documents", () => {
    expect(
      isFocusedYoutubeChannel(
        {
          sourceType: "youtube",
          authors: '["The Pragmatic Engineer"]',
        },
        ["The Pragmatic Engineer"],
      ),
    ).toBe(true);
    expect(
      isFocusedYoutubeChannel(
        { sourceType: "article", authors: ["The Pragmatic Engineer"] },
        ["The Pragmatic Engineer"],
      ),
    ).toBe(false);
  });
});
