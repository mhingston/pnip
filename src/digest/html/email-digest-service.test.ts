import { describe, it, expect, vi } from "vitest";
import { createEmailDigestService } from "./email-digest-service.js";
import type {
  ResendClient,
  ResendEmailResult,
} from "./resend-client.js";
import type { MarkdownDigestRow } from "../markdown/markdown-digest-repository.js";
import type { EmailDigestRow } from "./email-digest-repository.js";
import type { Edition } from "../../database/kysely.js";
import type { Logger } from "../../logging/logger.js";

function silentLogger(): Logger {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: function () {
      return this;
    },
  } as unknown as Logger;
}

function makeEdition(): Edition {
  return {
    id: "ed-1",
    publication_date: new Date("2026-07-07T00:00:00Z"),
    status: "ready",
    created_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    partition_key: "master",
  };
}

function makeMarkdown(stub = "# Daily Digest — 2026-07-07\n\nBody.\n"): MarkdownDigestRow {
  return {
    id: "md-1",
    edition_id: "ed-1",
    content: stub,
    story_count: 1,
    document_count: 2,
    citation_count: 3,
    created_at: new Date(),
  };
}

function makeEmailRow(overrides: Partial<EmailDigestRow> = {}): EmailDigestRow {
  return {
    id: "ed-md-1",
    edition_id: "ed-1",
    subject: "Daily Digest — 2026-07-07",
    html_content: "<p>Body.</p>",
    text_content: "Body.",
    from_address: "from@example.com",
    to_addresses: ["to@example.com"],
    provider_kind: "resend",
    delivery_status: "pending",
    attempt_count: 0,
    provider_response: null,
    provider_message_id: null,
    failure_reason: null,
    attempted_at: null,
    completed_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeFakeResend(result: ResendEmailResult): ResendClient {
  return {
    sendEmail: vi.fn().mockResolvedValue(result),
  };
}

const successResult: ResendEmailResult = {
  ok: true,
  status: 200,
  messageId: "msg-1",
  raw: { id: "msg-1" },
};

const failureResult: ResendEmailResult = {
  ok: false,
  status: 422,
  errorBody: "validation error",
  raw: { message: "validation error" },
};

interface DepsOverrides {
  resend?: ResendClient;
  markdownRow?: MarkdownDigestRow;
  existingEmailRow?: EmailDigestRow | undefined;
  toAddresses?: string[];
}

function makeDeps(overrides: DepsOverrides = {}) {
  const markdownRow =
    "markdownRow" in overrides ? overrides.markdownRow : makeMarkdown();
  const existing = overrides.existingEmailRow;
  const resend = overrides.resend ?? makeFakeResend(successResult);

  const editionRepo = {
    getById: vi.fn().mockResolvedValue(makeEdition()),
    getByDate: vi.fn().mockResolvedValue(makeEdition()),
  };
  const markdownDigestRepo = {
    getByEdition: vi.fn().mockResolvedValue(markdownRow),
    createForEdition: vi.fn(),
    deleteByEdition: vi.fn(),
  };
  const emailDigestRepo = {
    getByEdition: vi.fn().mockImplementation(async () => existing),
    createForEdition: vi.fn().mockImplementation(async (input: any) =>
      makeEmailRow({
        edition_id: input.editionId,
        subject: input.subject,
        html_content: input.htmlContent,
        text_content: input.textContent,
        from_address: input.fromAddress,
        to_addresses: input.toAddresses,
        delivery_status: input.deliveryStatus ?? "pending",
        attempt_count: input.attemptCount ?? 0,
      }),
    ),
    updateDelivery: vi.fn().mockImplementation(async (id: string, update: any) =>
      makeEmailRow({
        id,
        delivery_status: update.deliveryStatus,
        attempt_count: update.attemptCount,
        provider_message_id: update.providerMessageId,
        failure_reason: update.failureReason,
        attempted_at: update.attemptedAt,
        completed_at: update.completedAt,
        provider_response: update.providerResponse,
      }),
    ),
    deleteByEdition: vi.fn(),
  };

  return {
    deps: {
      db: {} as never,
      editionRepo: editionRepo as never,
      markdownDigestRepo: markdownDigestRepo as never,
      emailDigestRepo: emailDigestRepo as never,
      resend,
      config: {
        fromAddress: "from@example.com",
        toAddresses: overrides.toAddresses ?? ["to@example.com"],
      },
      logger: silentLogger(),
    },
    mocks: { editionRepo, markdownDigestRepo, emailDigestRepo, resend },
  };
}

describe("send — happy path", () => {
  it("creates the email digest row, sends, and persists the provider response", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });

    expect(result.deliveryStatus).toBe("sent");
    expect(result.attemptCount).toBe(1);
    expect(result.providerMessageId).toBe("msg-1");
    expect(result.alreadyExisted).toBe(false);
    expect(result.attempted).toBe(true);
    expect(mocks.emailDigestRepo.createForEdition).toHaveBeenCalledOnce();
    expect(mocks.emailDigestRepo.updateDelivery).toHaveBeenCalledOnce();
    expect(mocks.resend.sendEmail).toHaveBeenCalledOnce();
  });

  it("passes subject/html/text/to/from to the Resend client", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createEmailDigestService(deps);
    await svc.send({ editionId: "ed-1" });
    const arg = (mocks.resend.sendEmail as ReturnType<typeof vi.fn>).mock
      .calls[0]![0]!;
    expect(arg.from).toBe("from@example.com");
    expect(arg.to).toEqual(["to@example.com"]);
    expect(arg.subject).toMatch(/^Daily Digest —/);
    expect(arg.html).toContain("<!doctype html>");
    expect(arg.text).toContain("Daily Digest");
    expect(arg.idempotencyKey).toMatch(/^pnip:ed-1:/);
    expect(arg.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source", value: "pnip-digestive" }),
        expect.objectContaining({ name: "edition_id", value: "ed-1" }),
      ]),
    );
  });
});

describe("send — failure path", () => {
  it("persists the failure_reason when Resend returns ok=false", async () => {
    const { deps, mocks } = makeDeps({
      resend: makeFakeResend(failureResult),
    });
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });
    expect(result.deliveryStatus).toBe("failed");
    expect(result.failureReason).toMatch(/HTTP 422/);
    expect(result.providerMessageId).toBeNull();
    expect(mocks.emailDigestRepo.updateDelivery).toHaveBeenCalledOnce();
  });
});

describe("send — idempotency", () => {
  it("returns alreadyExisted=true without re-sending when an existing row is already 'sent'", async () => {
    const { deps, mocks } = makeDeps({
      existingEmailRow: makeEmailRow({ delivery_status: "sent" }),
    });
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.attempted).toBe(false);
    expect(mocks.resend.sendEmail).not.toHaveBeenCalled();
    expect(mocks.emailDigestRepo.createForEdition).not.toHaveBeenCalled();
  });

  it("attempts a fresh send when an existing row exists but is still 'pending'", async () => {
    const { deps, mocks } = makeDeps({
      existingEmailRow: makeEmailRow({ delivery_status: "pending" }),
    });
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });
    expect(result.deliveryStatus).toBe("sent");
    expect(mocks.resend.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.emailDigestRepo.createForEdition).not.toHaveBeenCalled();
    expect(mocks.emailDigestRepo.updateDelivery).toHaveBeenCalledOnce();
  });

  it("retries a previously-failed delivery", async () => {
    const { deps, mocks } = makeDeps({
      existingEmailRow: makeEmailRow({
        delivery_status: "failed",
        attempt_count: 2,
        failure_reason: "previous error",
      }),
      resend: makeFakeResend(successResult),
    });
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });
    expect(result.deliveryStatus).toBe("sent");
    expect(result.attemptCount).toBe(3); // previous 2 + this 1
    expect(mocks.resend.sendEmail).toHaveBeenCalledOnce();
  });
});

describe("send — recipient validation", () => {
  it("fails cleanly when no recipients are configured", async () => {
    const { deps, mocks } = makeDeps({ toAddresses: [] });
    const svc = createEmailDigestService(deps);
    const result = await svc.send({ editionId: "ed-1" });
    expect(result.deliveryStatus).toBe("failed");
    expect(result.failureReason).toMatch(/recipients/);
    expect(mocks.resend.sendEmail).not.toHaveBeenCalled();
  });
});

describe("send — missing markdown digest", () => {
  it("refuses to send when there is no markdown digest for the edition", async () => {
    const { deps, mocks } = makeDeps();
    mocks.markdownDigestRepo.getByEdition = vi.fn().mockResolvedValue(undefined);
    const svc = createEmailDigestService(deps);
    await expect(svc.send({ editionId: "ed-1" })).rejects.toThrow(
      /no markdown digest/,
    );
  });
});

describe("send — missing edition", () => {
  it("rejects an unknown editionId", async () => {
    const { deps, mocks } = makeDeps();
    mocks.editionRepo.getById = vi.fn().mockResolvedValue(undefined);
    const svc = createEmailDigestService(deps);
    await expect(svc.send({ editionId: "missing" })).rejects.toThrow(
      /edition not found/,
    );
  });
});

describe("sendForDate", () => {
  it("resolves edition by date then sends", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createEmailDigestService(deps);
    const result = await svc.sendForDate({ editionDate: "2026-07-07" });
    expect(result.deliveryStatus).toBe("sent");
    expect(mocks.editionRepo.getByDate).toHaveBeenCalledWith("2026-07-07");
    expect(mocks.resend.sendEmail).toHaveBeenCalledOnce();
  });

  it("throws when no edition found for the date", async () => {
    const { deps, mocks } = makeDeps();
    mocks.editionRepo.getByDate = vi.fn().mockResolvedValue(undefined);
    const svc = createEmailDigestService(deps);
    await expect(svc.sendForDate({ editionDate: "2030-01-01" })).rejects.toThrow(
      /no edition found/,
    );
  });
});

describe("preview", () => {
  it("returns rendered subject + html + text without sending", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createEmailDigestService(deps);
    const p = await svc.preview({ editionId: "ed-1" });
    expect(p.subject).toMatch(/Daily Digest/);
    expect(p.html).toContain("<!doctype html>");
    expect(p.text).toContain("Daily Digest");
    expect(mocks.resend.sendEmail).not.toHaveBeenCalled();
    expect(mocks.emailDigestRepo.createForEdition).not.toHaveBeenCalled();
  });
});
