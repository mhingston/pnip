import { describe, it, expect } from "vitest";
import { createFakeProvider } from "./fake-provider.js";

describe("FakeProvider", () => {
  it("generateText returns deterministic content including the prompt", () => {
    const p = createFakeProvider();
    const a = p.generateText({ prompt: "hello world" });
    return a.then((r) => {
      expect(r.content).toContain("hello world");
      expect(r.model).toBe("fake-text");
      expect(r.provider).toBe("fake");
    });
  });

  it("same prompt yields same content (deterministic)", async () => {
    const p = createFakeProvider();
    const r1 = await p.generateText({ prompt: "same prompt" });
    const r2 = await p.generateText({ prompt: "same prompt" });
    expect(r1.content).toBe(r2.content);
  });

  it("embed returns deterministic vectors of constant length; same text → same vector", async () => {
    const p = createFakeProvider();
    const r = await p.embed({ texts: ["alpha", "alpha", "beta"] });
    expect(r.model).toBe("fake-embed");
    expect(r.provider).toBe("fake");
    expect(r.vectors).toHaveLength(3);
    expect(r.vectors[0]).toEqual(r.vectors[1]);
    expect(r.vectors[0]).not.toEqual(r.vectors[2]);
    for (const v of r.vectors) {
      expect(v).toHaveLength(8);
      for (const n of v) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1);
      }
    }
  });

  it("embed is deterministic across provider instances", async () => {
    const a = await createFakeProvider().embed({ texts: ["x"] });
    const b = await createFakeProvider().embed({ texts: ["x"] });
    expect(a.vectors).toEqual(b.vectors);
  });

  it("supports a custom text function", async () => {
    const p = createFakeProvider({ text: (prompt) => "ECHO:" + prompt });
    const r = await p.generateText({ prompt: "abc" });
    expect(r.content).toBe("ECHO:abc");
  });

  it("supports a custom embed function", async () => {
    const p = createFakeProvider({ embed: (text) => [text.length, 0.5] });
    const r = await p.embed({ texts: ["hi", "hello"] });
    expect(r.vectors).toEqual([
      [2, 0.5],
      [5, 0.5],
    ]);
  });
});
