import { describe, expect, it, vi } from "vitest";
import { runActivePartitionsCommand } from "./active-partitions.js";

describe("runActivePartitionsCommand", () => {
  it("prints only database-resolved active partitions in shell format", async () => {
    const log = vi.fn();
    const result = await runActivePartitionsCommand({
      editionDate: "2026-07-10",
      partitionConfig: {
        youtube: { enabled: true, min_articles: 5 },
        blogs: { enabled: true, min_articles: 5, with_podcast: true },
      },
      resolveEditionId: vi.fn().mockResolvedValue("ed-1"),
      resolveActivePartitions: vi.fn().mockResolvedValue([
        { partitionKey: "master", documentCount: 9, withPodcast: false },
        { partitionKey: "blogs", documentCount: 5, withPodcast: true },
      ]),
      log,
    });

    expect(result.exitCode).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "master:with_podcast",
      "blogs:with_podcast",
    ]);
  });

  it("fails cleanly when the edition does not exist", async () => {
    const log = vi.fn();
    const result = await runActivePartitionsCommand({
      editionDate: "2026-07-10",
      partitionConfig: {},
      resolveEditionId: vi.fn().mockResolvedValue(undefined),
      resolveActivePartitions: vi.fn(),
      log,
    });
    expect(result.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith("active-partitions: no edition found for date 2026-07-10");
  });
});
