import { describe, it, expect } from "vitest";
import { createLogger, type Logger } from "./logger.js";

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line.replace(/\n$/, ""));
}

describe("logger", () => {
  it("emits one JSON line per call containing timestamp, level, message", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    logger.info("hello");

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);

    const rec = parse(lines[0]);
    expect(rec.level).toBe("info");
    expect(rec.message).toBe("hello");
    expect(typeof rec.timestamp).toBe("string");
    expect(new Date(rec.timestamp as string).toISOString()).toBe(rec.timestamp);
  });

  it("emits single-line JSON even when error stacks / fields contain newlines", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    const err = new Error("multi\nline\nmessage");
    logger.error("msg", { error: err, worker: "w\nx" });

    expect(lines).toHaveLength(1);
    const raw = lines[0].replace(/\n$/, "");
    expect(raw.includes("\n")).toBe(false);
    const rec = parse(lines[0]);
    expect(rec.worker).toBe("w\nx");
    expect((rec.error as { stack: string }).stack).toContain("\n");
  });

  it("respects minimum level: debug emitted at debug, dropped at info", () => {
    const debugLines: string[] = [];
    const debugLogger = createLogger({ sink: (l) => debugLines.push(l), level: "debug" });
    debugLogger.debug("d");
    expect(debugLines).toHaveLength(1);
    expect(parse(debugLines[0]).level).toBe("debug");

    const infoLines: string[] = [];
    const infoLogger = createLogger({ sink: (l) => infoLines.push(l), level: "info" });
    infoLogger.debug("dropped");
    infoLogger.warn("kept");
    expect(infoLines).toHaveLength(1);
    expect(parse(infoLines[0]).level).toBe("warn");
  });

  it("child() merges context and overrides parent fields; child does not mutate parent", () => {
    const lines: string[] = [];
    const parent = createLogger({
      sink: (l) => lines.push(l),
      level: "debug",
      baseFields: { worker: "discovery", jobId: "j1", editionId: "e1" },
    });
    const child = parent.child({ jobId: "j2", stage: "expand" });
    child.info("child msg");
    const rec = parse(lines[0]);
    expect(rec.worker).toBe("discovery");
    expect(rec.jobId).toBe("j2");
    expect(rec.stage).toBe("expand");
    expect(rec.editionId).toBe("e1");

    const parentLines: string[] = [];
    const parent2 = createLogger({
      sink: (l) => parentLines.push(l),
      level: "debug",
      baseFields: { worker: "discovery", jobId: "j1" },
    });
    const child2 = parent2.child({ jobId: "j2" });
    child2.child({ jobId: "j3", stage: "deep" });
    parent2.info("parent msg");
    const prec = parse(parentLines[0]);
    expect(prec.jobId).toBe("j1");
    expect(prec.stage).toBeUndefined();
  });

  it("per-call fields override base context for that record only", () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (l) => lines.push(l),
      level: "debug",
      baseFields: { jobId: "base", worker: "w" },
    });
    logger.info("msg", { jobId: "override", durationMs: 42 });
    const rec = parse(lines[0]);
    expect(rec.jobId).toBe("override");
    expect(rec.durationMs).toBe(42);
    expect(rec.worker).toBe("w");

    logger.info("msg2");
    const rec2 = parse(lines[1]);
    expect(rec2.jobId).toBe("base");
    expect(rec2.durationMs).toBeUndefined();
  });

  it("error field (Error instance) renders as { type, message, stack } with retryCount/provider", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    const err: Error & { retryCount?: number; provider?: unknown } = new Error("boom");
    err.name = "FetchError";
    err.retryCount = 3;
    err.provider = "openai";
    logger.error("failed", { error: err });

    const rec = parse(lines[0]);
    expect(rec.error).toEqual({
      type: "FetchError",
      message: "boom",
      stack: err.stack,
    });
    expect(rec.retryCount).toBe(3);
    expect(rec.provider).toBe("openai");
  });

  it("error field pulls provider from providerMetadata when .provider absent", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    const err: Error & { providerMetadata?: unknown } = new Error("x");
    err.providerMetadata = { model: "gpt-4", tokens: 100 };
    logger.error("failed", { error: err });

    const rec = parse(lines[0]);
    expect(rec.provider).toEqual({ model: "gpt-4", tokens: 100 });
  });

  it("error field with plain object { name, message, stack } works", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    logger.error("failed", { error: { name: "X", message: "m", stack: "s" } });

    const rec = parse(lines[0]);
    expect(rec.error).toEqual({ type: "X", message: "m", stack: "s" });
  });

  it("explicit per-call retryCount/provider override error-extracted values", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    const err: Error & { retryCount?: number; provider?: unknown } = new Error("boom");
    err.retryCount = 1;
    err.provider = "from-error";
    logger.error("failed", { error: err, retryCount: 9, provider: "from-call" });

    const rec = parse(lines[0]);
    expect(rec.retryCount).toBe(9);
    expect(rec.provider).toBe("from-call");
  });

  it("correlationId is inherited across child() and stable, but can be overridden", () => {
    const lines: string[] = [];
    const parent = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    parent.info("p");
    const child = parent.child({ worker: "w" });
    child.info("c");
    const grandchild = child.child({ stage: "s" });
    grandchild.info("g");

    const p = parse(lines[0]);
    const c = parse(lines[1]);
    const g = parse(lines[2]);
    const corr = p.correlationId;
    expect(typeof corr).toBe("string");
    expect(corr).toHaveLength(36);
    expect(c.correlationId).toBe(corr);
    expect(g.correlationId).toBe(corr);

    const customChild = parent.child({ correlationId: "custom" });
    customChild.info("custom");
    expect(parse(lines[3]).correlationId).toBe("custom");

    child.info("percall", { correlationId: "percall-id" });
    expect(parse(lines[4]).correlationId).toBe("percall-id");

    child.info("after");
    expect(parse(lines[5]).correlationId).toBe(corr);
  });

  it("createLogger returns a Logger; child returns a Logger", () => {
    const lines: string[] = [];
    const logger: Logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    const child: Logger = logger.child({ worker: "w" });
    expect(typeof logger.info).toBe("function");
    expect(typeof child.child).toBe("function");
  });
});
