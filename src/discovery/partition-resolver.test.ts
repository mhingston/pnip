import { describe, it, expect } from "vitest";
import {
  categoryToPartitionKey,
  PARTITION_MASTER,
  resolvePartitionKey,
} from "./partition-resolver.js";
import type { PartitionConfig } from "../config/index.js";

describe("categoryToPartitionKey — config-driven routing", () => {
  it("returns PARTITION_MASTER for null category", () => {
    expect(categoryToPartitionKey({ category: null })).toBe(PARTITION_MASTER);
  });

  it("returns PARTITION_MASTER for undefined category", () => {
    expect(categoryToPartitionKey({ category: undefined })).toBe(
      PARTITION_MASTER,
    );
  });

  it("returns PARTITION_MASTER when no config is provided (default behaviour)", () => {
    expect(
      categoryToPartitionKey({ category: { id: 2, title: "Blogs" } }),
    ).toBe(PARTITION_MASTER);
  });

  it("returns PARTITION_MASTER when config is empty", () => {
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config: {},
      }),
    ).toBe(PARTITION_MASTER);
  });

  it("routes a category matching the config to the configured partition key", () => {
    const config: PartitionConfig = {
      youtube: { category: "YouTube" },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config,
      }),
    ).toBe("youtube");
  });

  it("routes a category NOT matching the config to master", () => {
    const config: PartitionConfig = {
      youtube: { category: "YouTube" },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 2, title: "Blogs" },
        config,
      }),
    ).toBe(PARTITION_MASTER);
  });

  it("disabled partition's category mapping is ignored (falls through to master)", () => {
    const config: PartitionConfig = {
      youtube: { category: "YouTube", enabled: false },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config,
      }),
    ).toBe(PARTITION_MASTER);
  });

  it("category_id is honoured as a routing key", () => {
    const config: PartitionConfig = {
      youtube: { category_id: 3 },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "Totally Unrelated Title" },
        config,
      }),
    ).toBe("youtube");
  });

  it("title match is case-insensitive", () => {
    const config: PartitionConfig = {
      youtube: { category: "YOUTUBE" },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "youtube" },
        config,
      }),
    ).toBe("youtube");
  });

  it("title match with mixed case still routes", () => {
    const config: PartitionConfig = {
      youtube: { category: "YouTube" },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "youtube" },
        config,
      }),
    ).toBe("youtube");
  });

  it("multiple partitions: first match wins (iteration order)", () => {
    const config: PartitionConfig = {
      youtube: { category: "YouTube" },
      videos: { category_id: 3 },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config,
      }),
    ).toBe("youtube");
  });

  it("title takes precedence over category_id when both are set on different partitions", () => {
    const config: PartitionConfig = {
      a: { category: "YouTube" },
      b: { category_id: 3 },
    };
    expect(
      categoryToPartitionKey({
        category: { id: 3, title: "YouTube" },
        config,
      }),
    ).toBe("a");
  });
});

describe("resolvePartitionKey", () => {
  it("delegates to categoryToPartitionKey using entry.category and config", () => {
    const config: PartitionConfig = { youtube: { category: "YouTube" } };
    expect(
      resolvePartitionKey({
        entry: { category: { id: 3, title: "YouTube" } },
        config,
      }),
    ).toBe("youtube");
    expect(
      resolvePartitionKey({
        entry: { category: null },
        config,
      }),
    ).toBe(PARTITION_MASTER);
    expect(
      resolvePartitionKey({
        entry: { category: undefined },
        config,
      }),
    ).toBe(PARTITION_MASTER);
  });

  it("returns master when no config is provided (default behaviour)", () => {
    expect(
      resolvePartitionKey({
        entry: { category: { id: 3, title: "YouTube" } },
      }),
    ).toBe(PARTITION_MASTER);
  });
});