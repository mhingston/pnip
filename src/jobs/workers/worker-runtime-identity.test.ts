import { describe, expect, it } from "vitest";
import { resolveWorkerIdentity } from "./worker-runtime.js";
import type { Worker } from "./worker.js";

describe("resolveWorkerIdentity", () => {
  it("uses the explicit worker name when one is provided", () => {
    const worker: Worker = {
      name: "summarize-story",
      supports: () => true,
      execute: async () => ({}),
    };

    expect(resolveWorkerIdentity(worker, "summarize_story")).toBe(
      "summarize-story",
    );
  });

  it("uses the job type for anonymous object-literal workers", () => {
    const worker: Worker = {
      supports: () => true,
      execute: async () => ({}),
    };

    expect(resolveWorkerIdentity(worker, "summarize_story")).toBe(
      "summarize_story",
    );
    expect(resolveWorkerIdentity(worker, "summarize_story")).not.toBe(
      "Object",
    );
  });

  it("ignores blank explicit names", () => {
    const worker: Worker = {
      name: "  ",
      supports: () => true,
      execute: async () => ({}),
    };

    expect(resolveWorkerIdentity(worker, "expand_document")).toBe(
      "expand_document",
    );
  });
});
