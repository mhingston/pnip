import { describe, it, expect } from "vitest";
import {
  parsePartitionConfig,
  type PartitionConfig,
} from "./index.js";
import {
  categoryToPartitionKey,
  resolvePartitionKey,
} from "../discovery/partition-resolver.js";

describe("parsePartitionConfig", () => {
  it("returns {} when raw is undefined", () => {
    expect(parsePartitionConfig(undefined)).toEqual({});
  });

  it("returns {} when raw is the empty string", () => {
    expect(parsePartitionConfig("")).toEqual({});
  });

  it("returns {} when raw is whitespace only", () => {
    expect(parsePartitionConfig("   \n\t  ")).toEqual({});
  });

  it("parses a single-partition config with min_articles", () => {
    expect(parsePartitionConfig('{"youtube":{"min_articles":5}}')).toEqual({
      youtube: { min_articles: 5 },
    });
  });

  it("parses a full config roundtrip including enabled and with_podcast", () => {
    const raw = JSON.stringify({
      youtube: {
        min_articles: 5,
        enabled: true,
        with_podcast: false,
      },
      blogs: {
        min_articles: 3,
        enabled: false,
        with_podcast: true,
      },
    });
    const expected: PartitionConfig = {
      youtube: { min_articles: 5, enabled: true, with_podcast: false },
      blogs: { min_articles: 3, enabled: false, with_podcast: true },
    };
    expect(parsePartitionConfig(raw)).toEqual(expected);
  });

  it("ignores unknown keys inside an entry (only known fields are mapped)", () => {
    const raw = JSON.stringify({
      youtube: { min_articles: 5, garbage: "ignored" },
    });
    expect(parsePartitionConfig(raw)).toEqual({
      youtube: { min_articles: 5 },
    });
  });

  it("accepts zero as a min_articles value", () => {
    expect(parsePartitionConfig('{"x":{"min_articles":0}}')).toEqual({
      x: { min_articles: 0 },
    });
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePartitionConfig("{not json")).toThrow(
      /Invalid PARTITION_CONFIG/,
    );
  });

  it("throws when root is an array", () => {
    expect(() => parsePartitionConfig("[]")).toThrow(
      /Invalid PARTITION_CONFIG/,
    );
  });

  it("throws when root is a primitive", () => {
    expect(() => parsePartitionConfig("42")).toThrow(/Invalid PARTITION_CONFIG/);
    expect(() => parsePartitionConfig('"hi"')).toThrow(
      /Invalid PARTITION_CONFIG/,
    );
    expect(() => parsePartitionConfig("null")).toThrow(
      /Invalid PARTITION_CONFIG/,
    );
  });

  it("throws when an entry is not an object", () => {
    expect(() => parsePartitionConfig('{"x": "string"}')).toThrow(
      /Invalid PARTITION_CONFIG.*"x".*object/,
    );
    expect(() => parsePartitionConfig('{"x": 7}')).toThrow(
      /Invalid PARTITION_CONFIG.*"x".*object/,
    );
    expect(() => parsePartitionConfig('{"x": null}')).toThrow(
      /Invalid PARTITION_CONFIG.*"x".*object/,
    );
    expect(() => parsePartitionConfig('{"x": ["a"]}')).toThrow(
      /Invalid PARTITION_CONFIG.*"x".*object/,
    );
  });

  it("throws on wrong-type min_articles (string)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"min_articles":"5"}}'),
    ).toThrow(/min_articles must be a non-negative integer/);
  });

  it("throws on negative min_articles", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"min_articles":-1}}'),
    ).toThrow(/min_articles must be a non-negative integer/);
  });

  it("throws on non-integer min_articles", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"min_articles":1.5}}'),
    ).toThrow(/min_articles must be a non-negative integer/);
  });

  it("throws on wrong-type enabled (string)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"enabled":"true"}}'),
    ).toThrow(/enabled must be a boolean/);
  });

  it("throws on wrong-type with_podcast (number)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"with_podcast":1}}'),
    ).toThrow(/with_podcast must be a boolean/);
  });

  it("parses category as a non-empty string", () => {
    expect(
      parsePartitionConfig('{"youtube":{"category":"YouTube"}}'),
    ).toEqual({
      youtube: { category: "YouTube" },
    });
  });

  it("parses category_id as a positive integer", () => {
    expect(parsePartitionConfig('{"youtube":{"category_id":3}}')).toEqual({
      youtube: { category_id: 3 },
    });
  });

  it("parses a full entry combining category, category_id, min_articles, enabled, with_podcast", () => {
    const raw = JSON.stringify({
      youtube: {
        category: "YouTube",
        category_id: 3,
        min_articles: 5,
        enabled: true,
        with_podcast: false,
      },
    });
    expect(parsePartitionConfig(raw)).toEqual({
      youtube: {
        category: "YouTube",
        category_id: 3,
        min_articles: 5,
        enabled: true,
        with_podcast: false,
      },
    });
  });

  it("throws on empty-string category", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category":""}}'),
    ).toThrow(/category must be a non-empty string/);
  });

  it("throws on wrong-type category (number)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category":3}}'),
    ).toThrow(/category must be a non-empty string/);
  });

  it("throws on wrong-type category (boolean)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category":true}}'),
    ).toThrow(/category must be a non-empty string/);
  });

  it("throws on zero category_id", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category_id":0}}'),
    ).toThrow(/category_id must be a positive integer/);
  });

  it("throws on negative category_id", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category_id":-1}}'),
    ).toThrow(/category_id must be a positive integer/);
  });

  it("throws on non-integer category_id", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category_id":1.5}}'),
    ).toThrow(/category_id must be a positive integer/);
  });

  it("throws on wrong-type category_id (string)", () => {
    expect(() =>
      parsePartitionConfig('{"youtube":{"category_id":"3"}}'),
    ).toThrow(/category_id must be a positive integer/);
  });
});

describe("parsePartitionConfig + resolver integration", () => {
  it("routes categories via category mapping end-to-end", () => {
    const config = parsePartitionConfig(
      '{"youtube":{"category":"YouTube","min_articles":5,"enabled":true}}',
    );
    expect(
      resolvePartitionKey({
        entry: { category: { id: 3, title: "YouTube" } },
        config,
      }),
    ).toBe("youtube");
  });

  it("routes categories via category_id mapping end-to-end", () => {
    const config = parsePartitionConfig(
      '{"youtube":{"category_id":3,"min_articles":5,"enabled":true}}',
    );
    expect(
      resolvePartitionKey({
        entry: { category: { id: 3, title: "Anything" } },
        config,
      }),
    ).toBe("youtube");
  });

  it("non-matching categories fall through to master even with config set", () => {
    const config = parsePartitionConfig(
      '{"youtube":{"category":"YouTube","min_articles":5,"enabled":true}}',
    );
    expect(
      resolvePartitionKey({
        entry: { category: { id: 2, title: "Blogs" } },
        config,
      }),
    ).toBe("master");
  });

  it("empty PARTITION_CONFIG routes every category to master", () => {
    const config = parsePartitionConfig(undefined);
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config,
      }),
    ).toBe("master");
    expect(
      categoryToPartitionKey({
        category: { id: 2, title: "Blogs" },
        config,
      }),
    ).toBe("master");
    expect(
      categoryToPartitionKey({
        category: { id: 4, title: "Reddit" },
        config,
      }),
    ).toBe("master");
  });
});