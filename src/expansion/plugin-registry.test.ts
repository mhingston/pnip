import { describe, it, expect } from "vitest";
import { createPluginRegistry } from "./plugin-registry.js";
import type { ExpansionPlugin, ExpandResult } from "./types.js";

function makePlugin(name: string, ...supportedUrls: string[]): ExpansionPlugin {
  return {
    name,
    supports: (url: string) => supportedUrls.some((s) => url.startsWith(s)),
    expand: async () => ({
      title: name,
      content: "content",
      plainText: "content",
      sourceType: "article",
      sections: [],
    }),
  };
}

describe("PluginRegistry", () => {
  it("selects the first matching plugin by registration order", async () => {
    const registry = createPluginRegistry();
    const p1 = makePlugin("p1", "https://a.com");
    const p2 = makePlugin("p2", "https://a.com/blog");
    registry.register(p1);
    registry.register(p2);

    const selected = registry.select("https://a.com/blog/post");
    expect(selected).toBeDefined();
    expect(selected!.name).toBe("p1");
  });

  it("returns undefined when no plugin matches", () => {
    const registry = createPluginRegistry();
    expect(registry.select("https://unknown.com")).toBeUndefined();
  });

  it("allows overriding by order", () => {
    const registry = createPluginRegistry();
    const p1 = makePlugin("generic", "https://a.com");
    const p2 = makePlugin("specific", "https://a.com/blog");
    registry.register(p1);
    registry.register(p2);

    expect(registry.select("https://a.com/blog/x")?.name).toBe("generic");
    expect(registry.select("https://a.com/page")?.name).toBe("generic");
  });

  it("expand uses the matching plugin", async () => {
    const registry = createPluginRegistry();
    const article = makePlugin("article", "https://example.com");
    registry.register(article);

    const plugin = registry.select("https://example.com/article");
    const result = await plugin!.expand({ url: "https://example.com/article", editionId: "e1", discoveryEventId: "d1" });
    expect(result.title).toBe("article");
  });
});
