import { describe, it, expect, vi } from "vitest";
import { runDiscoverCommand } from "./discover.js";
import type { DiscoveryService } from "../discovery/discovery-service.js";
import type { MinifluxClient } from "../discovery/miniflux-client.js";

function fakeMiniflux(): MinifluxClient {
  return {
    listUnreadEntries: vi.fn(),
    markEntryRead: vi.fn(),
    markEntriesRead: vi.fn(),
  };
}

describe("runDiscoverCommand", () => {
  it("returns exitCode 0 and logs summary on success", async () => {
    const fakeService: DiscoveryService = {
      discover: vi.fn().mockResolvedValue({
        editionId: "e1",
        total: 3,
        created: 2,
        duplicates: 1,
        enqueued: 2,
        failed: 0,
      }),
    };
    const logs: string[] = [];
    const result = await runDiscoverCommand({
      service: fakeService,
      miniflux: fakeMiniflux(),
      log: (m) => { logs.push(m); },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toBeDefined();
    expect(result.result!.total).toBe(3);
    expect(logs.some((l) => l.includes("3") && l.includes("e1"))).toBe(true);
  });

  it("calls discover with today() when no editionDate passed", async () => {
    const discover = vi.fn().mockResolvedValue({
      editionId: "e1", total: 0, created: 0, duplicates: 0, enqueued: 0, failed: 0,
    });
    const fakeService: DiscoveryService = { discover };
    await runDiscoverCommand({ service: fakeService, miniflux: fakeMiniflux() });

    const today = new Date().toISOString().slice(0, 10);
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ editionDate: today }),
    );
  });

  it("passes custom editionDate through", async () => {
    const discover = vi.fn().mockResolvedValue({
      editionId: "e1", total: 0, created: 0, duplicates: 0, enqueued: 0, failed: 0,
    });
    const fakeService: DiscoveryService = { discover };
    await runDiscoverCommand({
      service: fakeService,
      miniflux: fakeMiniflux(),
      editionDate: "2026-01-01",
    });

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ editionDate: "2026-01-01" }),
    );
  });

  it("returns exitCode 1 and logs error on failure", async () => {
    const fakeService: DiscoveryService = {
      discover: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const logs: string[] = [];
    const result = await runDiscoverCommand({
      service: fakeService,
      miniflux: fakeMiniflux(),
      log: (m) => { logs.push(m); },
    });

    expect(result.exitCode).toBe(1);
    expect(result.result).toBeUndefined();
    expect(logs.some((l) => l.includes("boom") || l.includes("failed"))).toBe(true);
  });

  it("uses default console.log when no log provided", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fakeService: DiscoveryService = {
      discover: vi.fn().mockResolvedValue({
        editionId: "e1", total: 0, created: 0, duplicates: 0, enqueued: 0, failed: 0,
      }),
    };
    const result = await runDiscoverCommand({ service: fakeService, miniflux: fakeMiniflux() });
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });
});
