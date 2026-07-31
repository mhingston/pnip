import { describe, expect, it } from "vitest";
import {
  isPermanentExpansionError,
  looksLikePermanentFabricFailure,
  PermanentExpansionError,
} from "./permanent-expansion-error.js";

describe("PermanentExpansionError", () => {
  it("instanceof + brand check both recognise the error", () => {
    const err = new PermanentExpansionError("nope");
    expect(err).toBeInstanceOf(PermanentExpansionError);
    expect(isPermanentExpansionError(err)).toBe(true);
    expect(err.name).toBe("PermanentExpansionError");
    expect(err.message).toBe("nope");
  });

  it("does not match plain Errors", () => {
    expect(isPermanentExpansionError(new Error("nope"))).toBe(false);
    expect(isPermanentExpansionError(null)).toBe(false);
    expect(isPermanentExpansionError(undefined)).toBe(false);
    expect(isPermanentExpansionError({})).toBe(false);
  });

  it("matches duck-typed objects carrying the brand", () => {
    const duck = Object.assign(new Error("x"), { isPermanentExpansionError: true });
    expect(isPermanentExpansionError(duck)).toBe(true);
  });
});

describe("looksLikePermanentFabricFailure", () => {
  it("matches fabric's 'no VTT files found' diagnostic", () => {
    expect(looksLikePermanentFabricFailure(undefined, "no VTT files found in directory")).toBe(
      true,
    );
  });

  it("matches yt-dlp's 'no automatic captions / no subtitles'", () => {
    expect(
      looksLikePermanentFabricFailure(
        "8uncdjpygSU has no automatic captions",
        "8uncdjpygSU has no subtitles",
      ),
    ).toBe(true);
  });

  it("matches generic 'no transcript' wording", () => {
    expect(looksLikePermanentFabricFailure("fabric: no transcript available", "")).toBe(true);
  });

  it("matches video-unavailable variants", () => {
    expect(looksLikePermanentFabricFailure("", "Video unavailable")).toBe(true);
    expect(looksLikePermanentFabricFailure("", "This video is private")).toBe(true);
    expect(looksLikePermanentFabricFailure("", "video removed by the uploader")).toBe(true);
  });

  it("matches the 'Sign in to confirm you're not a bot' gate", () => {
    expect(
      looksLikePermanentFabricFailure("", "Sign in to confirm you're not a bot"),
    ).toBe(true);
  });

  it("does not flag transient network errors", () => {
    expect(looksLikePermanentFabricFailure("fetch failed", "")).toBe(false);
    expect(looksLikePermanentFabricFailure("ECONNRESET", "")).toBe(false);
    expect(looksLikePermanentFabricFailure("HTTP 503", "")).toBe(false);
    expect(looksLikePermanentFabricFailure("", "")).toBe(false);
  });
});
