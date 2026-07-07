import { describe, it, expect, vi } from "vitest";
import {
  GENERATE_EMAIL_HELP,
  parseGenerateEmailFlags,
  runGenerateEmailCommand,
  todayDate,
} from "./generate-email.js";
import type { EmailDigestService } from "../digest/html/email-digest-service.js";

function makeFakeService(impl: Partial<EmailDigestService> = {}): EmailDigestService {
  return {
    send: vi.fn(),
    sendForDate: vi.fn(),
    preview: vi.fn(),
    previewForDate: vi.fn(),
    ...impl,
  };
}

function makeSentResult() {
  return {
    emailDigestId: "ed-md-1",
    edition: {
      id: "ed-1",
      publication_date: new Date("2026-07-07"),
      status: "ready",
      created_at: new Date(),
      updated_at: new Date(),
      published_at: null,
      failed_at: null,
      failure_reason: null,
      cluster_stories_enqueued_at: null,
      metadata: null,
    },
    deliveryStatus: "sent" as const,
    attemptCount: 1,
    providerMessageId: "msg-1",
    failureReason: null,
    subject: "Daily Digest — 2026-07-07",
    alreadyExisted: false,
    attempted: true,
  };
}

describe("parseGenerateEmailFlags", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseGenerateEmailFlags({ args: [] });
    expect(r.errors).toEqual([]);
    expect(r.help).toBe(false);
    expect(r.dryRun).toBe(false);
    expect(r.editionDate).toBeUndefined();
  });

  it("parses --date YYYY-MM-DD", () => {
    const r = parseGenerateEmailFlags({ args: ["--date", "2026-07-07"] });
    expect(r.editionDate).toBe("2026-07-07");
    expect(r.errors).toEqual([]);
  });

  it("parses --dry-run", () => {
    const r = parseGenerateEmailFlags({ args: ["--dry-run"] });
    expect(r.dryRun).toBe(true);
  });

  it("records -h / --help", () => {
    expect(parseGenerateEmailFlags({ args: ["-h"] }).help).toBe(true);
    expect(parseGenerateEmailFlags({ args: ["--help"] }).help).toBe(true);
  });

  it("errors on invalid date format", () => {
    const r = parseGenerateEmailFlags({ args: ["--date", "07-07-2026"] });
    expect(r.errors[0]).toMatch(/invalid date/);
  });

  it("errors on unknown flags", () => {
    const r = parseGenerateEmailFlags({ args: ["--bork"] });
    expect(r.errors).toEqual(["unknown flag: --bork"]);
  });
});

describe("runGenerateEmailCommand — send path", () => {
  it("returns exitCode 0 and calls sendForDate on success", async () => {
    const service = makeFakeService({
      sendForDate: vi.fn().mockResolvedValue(makeSentResult()),
    });
    const logs: string[] = [];
    const result = await runGenerateEmailCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(service.sendForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
    });
    expect(logs.some((l) => l.includes("status=sent"))).toBe(true);
  });

  it("uses todayDate() when no date is provided", async () => {
    const service = makeFakeService({
      sendForDate: vi.fn().mockResolvedValue(makeSentResult()),
    });
    await runGenerateEmailCommand({ service });
    expect(service.sendForDate).toHaveBeenCalledWith({
      editionDate: todayDate(),
    });
  });

  it("returns exitCode 1 when delivery status is failed", async () => {
    const service = makeFakeService({
      sendForDate: vi.fn().mockResolvedValue({
        ...makeSentResult(),
        deliveryStatus: "failed" as const,
        providerMessageId: null,
        failureReason: "HTTP 422: bad",
      }),
    });
    const logs: string[] = [];
    const result = await runGenerateEmailCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("HTTP 422: bad"))).toBe(true);
  });

  it("returns exitCode 1 and logs on thrown error", async () => {
    const service = makeFakeService({
      sendForDate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const logs: string[] = [];
    const result = await runGenerateEmailCommand({
      service,
      editionDate: "2026-07-07",
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("boom") || l.includes("failed"))).toBe(
      true,
    );
  });
});

describe("runGenerateEmailCommand — dry-run path", () => {
  it("returns a preview without sending", async () => {
    const service = makeFakeService({
      previewForDate: vi.fn().mockResolvedValue({
        edition: {
          id: "ed-1",
          publication_date: new Date("2026-07-07"),
          status: "ready",
          created_at: new Date(),
          updated_at: new Date(),
          published_at: null,
          failed_at: null,
          failure_reason: null,
          cluster_stories_enqueued_at: null,
          metadata: null,
        },
        markdown: {
          id: "md-1",
          edition_id: "ed-1",
          content: "# Daily Digest — 2026-07-07",
          story_count: 1,
          document_count: 1,
          citation_count: 0,
          created_at: new Date(),
        },
        subject: "Daily Digest — 2026-07-07",
        html: "<!doctype html>...",
        text: "Daily Digest — 2026-07-07",
      }),
    });
    const logs: string[] = [];
    const result = await runGenerateEmailCommand({
      service,
      editionDate: "2026-07-07",
      dryRun: true,
      log: (m) => {
        logs.push(m);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe("Daily Digest — 2026-07-07");
    expect(service.previewForDate).toHaveBeenCalledWith({
      editionDate: "2026-07-07",
    });
    expect(logs.some((l) => l.includes("Preview"))).toBe(true);
  });
});

describe("GENERATE_EMAIL_HELP", () => {
  it("includes the command name and key flags", () => {
    expect(GENERATE_EMAIL_HELP).toContain("digestive generate-email");
    expect(GENERATE_EMAIL_HELP).toContain("--date");
    expect(GENERATE_EMAIL_HELP).toContain("--dry-run");
  });
});
