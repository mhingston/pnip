import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createFakeProvider } from "./fake-provider.js";
import { createPromptExecutionService } from "./prompt-execution.js";
import type { PromptVersion } from "../database/kysely.js";

function pv(template: string): PromptVersion {
  return {
    id: "pv-1",
    name: "test-prompt",
    version: 3,
    template,
    purpose: "testing",
    created_at: new Date("2024-01-01T00:00:00Z"),
  };
}

describe("PromptExecutionService", () => {
  it("renders {{key}} placeholders into the prompt sent to the provider", async () => {
    const seen: string[] = [];
    const provider = createFakeProvider({
      text: (prompt) => {
        seen.push(prompt);
        return "OK:" + prompt;
      },
    });
    const svc = createPromptExecutionService();
    const out = await svc.execute({
      promptVersion: pv("Summarize: {{topic}}"),
      variables: { topic: "cats" },
      provider,
    });
    expect(seen[0]).toBe("Summarize: cats");
    expect(out.content).toBe("OK:Summarize: cats");
  });

  it("replaces missing variables with empty string", async () => {
    const seen: string[] = [];
    const provider = createFakeProvider({
      text: (prompt) => {
        seen.push(prompt);
        return "X";
      },
    });
    const svc = createPromptExecutionService();
    await svc.execute({
      promptVersion: pv("A {{x}} B"),
      variables: {},
      provider,
    });
    expect(seen[0]).toBe("A  B");
  });

  it("inputHash is deterministic sha256 of the rendered prompt", async () => {
    const provider = createFakeProvider();
    const svc = createPromptExecutionService();
    const out = await svc.execute({
      promptVersion: pv("Summarize: {{topic}}"),
      variables: { topic: "cats" },
      provider,
    });
    const expected = createHash("sha256").update("Summarize: cats").digest("hex");
    expect(out.inputHash).toBe(expected);
    expect(out.inputHash).toBe(
      "c788b961ab8644ffe14fd2b079f9296893e85dd1e9d36df3f7e5f34e30340737",
    );

    const out2 = await svc.execute({
      promptVersion: pv("Summarize: {{topic}}"),
      variables: { topic: "dogs" },
      provider,
    });
    expect(out2.inputHash).not.toBe(out.inputHash);
  });

  it("returns full ArtifactMetadata fields", async () => {
    const provider = createFakeProvider();
    const svc = createPromptExecutionService();
    const out = await svc.execute({
      promptVersion: pv("Hello {{name}}"),
      variables: { name: "world" },
      provider,
      model: "gpt-4o-mini",
    });
    expect(out.promptId).toBe("pv-1");
    expect(out.promptVersion).toBe(3);
    expect(out.model).toBe("fake-text");
    expect(out.provider).toBe("fake");
    expect(typeof out.inputHash).toBe("string");
    expect(out.inputHash).toHaveLength(64);
    expect(out.content).toContain("Hello world");
    expect(new Date(out.createdAt).toISOString()).toBe(out.createdAt);
  });

  it("retries — eventual success after transient failures", async () => {
    const provider = createFakeProvider({ throwNTimes: 2 });
    const svc = createPromptExecutionService({ maxAttempts: 3, retryDelayMs: 1 });
    const out = await svc.execute({
      promptVersion: pv("Hi"),
      variables: {},
      provider,
    });
    expect(out.content).toContain("Hi");
  });

  it("retries — permanent failure rethrows the last error", async () => {
    const provider = createFakeProvider({ throwNTimes: 99 });
    const svc = createPromptExecutionService({ maxAttempts: 2, retryDelayMs: 1 });
    await expect(
      svc.execute({ promptVersion: pv("Hi"), variables: {}, provider }),
    ).rejects.toThrow(/boom/);
  });

  it("retry boundary: throwNTimes === maxAttempts throws; throwNTimes < maxAttempts succeeds", async () => {
    const provider3 = createFakeProvider({ throwNTimes: 3 });
    const svc3 = createPromptExecutionService({ maxAttempts: 3, retryDelayMs: 1 });
    await expect(
      svc3.execute({ promptVersion: pv("Hi"), variables: {}, provider: provider3 }),
    ).rejects.toThrow(/boom/);

    const provider4 = createFakeProvider({ throwNTimes: 3 });
    const svc4 = createPromptExecutionService({ maxAttempts: 4, retryDelayMs: 1 });
    const out = await svc4.execute({
      promptVersion: pv("Hi"),
      variables: {},
      provider: provider4,
    });
    expect(out.content).toContain("Hi");
  });
});
