import { describe, it, expect, vi } from "vitest";
import {
  createPublicationService,
  PublicationGateFailedError,
  type PublicationServiceDeps,
} from "./publication-service.js";
import {
  EditionNotFoundError,
  InvalidEditionTransitionError,
} from "../editions/edition-repository.js";
import type {
  Edition,
  EditionStatus,
} from "../database/kysely.js";
import type { MarkdownDigestRow } from "../digest/markdown/markdown-digest-repository.js";
import type { EmailDigestRow } from "../digest/html/email-digest-repository.js";
import type { NotebookRow } from "../digest/notebooklm/notebook-repository.js";
import type { PodcastRow } from "../digest/notebooklm/podcast-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { Logger } from "../logging/logger.js";

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

function makeEdition(overrides: Partial<Edition> = {}): Edition {
  return {
    id: "ed-1",
    publication_date: new Date("2026-07-07T00:00:00Z"),
    status: "ready",
    created_at: new Date("2026-07-07T00:00:00Z"),
    updated_at: new Date("2026-07-07T00:00:00Z"),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    ...overrides,
  };
}

function makeMarkdown(overrides: Partial<MarkdownDigestRow> = {}): MarkdownDigestRow {
  return {
    id: "md-1",
    edition_id: "ed-1",
    content: "# Daily Digest\n\nBody.\n",
    story_count: 1,
    document_count: 1,
    citation_count: 1,
    created_at: new Date(),
    ...overrides,
  };
}

function makeEmail(overrides: Partial<EmailDigestRow> = {}): EmailDigestRow {
  return {
    id: "em-1",
    edition_id: "ed-1",
    subject: "Daily Digest",
    html_content: "<p>Hi</p>",
    text_content: "Hi",
    from_address: "from@example.com",
    to_addresses: ["to@example.com"],
    provider_kind: "resend",
    delivery_status: "sent",
    attempt_count: 1,
    provider_response: null,
    provider_message_id: "msg-1",
    failure_reason: null,
    attempted_at: new Date(),
    completed_at: new Date(),
    created_at: new Date(),
    ...overrides,
  };
}

function makeNotebook(overrides: Partial<NotebookRow> = {}): NotebookRow {
  return {
    id: "nb-1",
    edition_id: "ed-1",
    notebook_external_id: "nb-ext-1",
    title: "Daily Digest",
    url: "https://notebooklm.google.com/notebook/nb-ext-1",
    source_count: 1,
    status: "ready",
    provider_response: null,
    created_at: new Date(),
    completed_at: new Date(),
    ...overrides,
  };
}

function makePodcast(overrides: Partial<PodcastRow> = {}): PodcastRow {
  return {
    id: "pod-1",
    edition_id: "ed-1",
    notebook_id: "nb-1",
    artifact_external_id: "artifact-1",
    url: "https://cdn.example.com/podcast.mp3",
    title: "Daily Digest",
    duration_seconds: 300,
    format: "deep-dive",
    language: "en",
    status: "ready",
    local_path: null,
    provider_response: null,
    failure_reason: null,
    started_at: new Date(),
    completed_at: new Date(),
    created_at: new Date(),
    ...overrides,
  };
}

interface FakeDeps {
  deps: PublicationServiceDeps;
  mocks: {
    editionRepo: {
      getById: ReturnType<typeof vi.fn>;
      getByDate: ReturnType<typeof vi.fn>;
      transition: ReturnType<typeof vi.fn>;
    };
    markdownDigestRepo: { getByEdition: ReturnType<typeof vi.fn> };
    emailDigestRepo: { getByEdition: ReturnType<typeof vi.fn> };
    notebookRepo: { getByEdition: ReturnType<typeof vi.fn> };
    podcastRepo: { getByEdition: ReturnType<typeof vi.fn> };
    jobQueue: { cancelForEdition: ReturnType<typeof vi.fn> };
  };
}

function makeFakeDeps(): FakeDeps {
  const editionRepo = {
    getById: vi.fn(),
    getByDate: vi.fn(),
    transition: vi.fn(),
  };
  const markdownDigestRepo = { getByEdition: vi.fn() };
  const emailDigestRepo = { getByEdition: vi.fn() };
  const notebookRepo = { getByEdition: vi.fn() };
  const podcastRepo = { getByEdition: vi.fn() };
  const jobQueue = { cancelForEdition: vi.fn() };

  const deps: PublicationServiceDeps = {
    db: {} as never,
    editionRepo: editionRepo as never,
    markdownDigestRepo: markdownDigestRepo as never,
    emailDigestRepo: emailDigestRepo as never,
    notebookRepo: notebookRepo as never,
    podcastRepo: podcastRepo as never,
    jobQueue: jobQueue as never,
    logger: silentLogger(),
  };

  return {
    deps,
    mocks: {
      editionRepo,
      markdownDigestRepo,
      emailDigestRepo,
      notebookRepo,
      podcastRepo,
      jobQueue,
    },
  };
}

describe("checkCompletion", () => {
  it("returns all booleans true and empty missingArtifacts when every row is ready", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svc = createPublicationService(deps);
    const report = await svc.checkCompletion("ed-1");

    expect(report.markdownExists).toBe(true);
    expect(report.markdownNonEmpty).toBe(true);
    expect(report.emailSent).toBe(true);
    expect(report.notebookReady).toBe(true);
    expect(report.podcastReady).toBe(true);
    expect(report.missingArtifacts).toEqual([]);
  });

  it("reports 'markdown digest missing or empty' when the row is missing", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(undefined);
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svc = createPublicationService(deps);
    const report = await svc.checkCompletion("ed-1");

    expect(report.markdownExists).toBe(false);
    expect(report.markdownNonEmpty).toBe(false);
    expect(report.missingArtifacts).toEqual([
      "markdown digest missing or empty",
    ]);
  });

  it("reports 'email not sent' when delivery_status is 'pending'", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "pending" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svc = createPublicationService(deps);
    const report = await svc.checkCompletion("ed-1");

    expect(report.emailSent).toBe(false);
    expect(report.missingArtifacts).toContain("email not sent");
  });

  it("reports 'email not sent' when delivery_status is 'failed'", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "failed" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svc = createPublicationService(deps);
    const report = await svc.checkCompletion("ed-1");

    expect(report.emailSent).toBe(false);
    expect(report.missingArtifacts).toContain("email not sent");
  });

  it("reports 'notebook not ready' when status is 'pending' or 'failed'", async () => {
    const { deps: depsA, mocks: mocksA } = makeFakeDeps();
    mocksA.editionRepo.getById.mockResolvedValue(makeEdition());
    mocksA.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocksA.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocksA.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "pending" }),
    );
    mocksA.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svcA = createPublicationService(depsA);
    const reportA = await svcA.checkCompletion("ed-1");
    expect(reportA.notebookReady).toBe(false);
    expect(reportA.missingArtifacts).toContain("notebook not ready");

    const { deps: depsB, mocks: mocksB } = makeFakeDeps();
    mocksB.editionRepo.getById.mockResolvedValue(makeEdition());
    mocksB.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocksB.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocksB.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "failed" }),
    );
    mocksB.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svcB = createPublicationService(depsB);
    const reportB = await svcB.checkCompletion("ed-1");
    expect(reportB.notebookReady).toBe(false);
    expect(reportB.missingArtifacts).toContain("notebook not ready");
  });

  it("reports 'podcast not ready or no URL' when status is 'generating' OR url is null", async () => {
    const { deps: depsA, mocks: mocksA } = makeFakeDeps();
    mocksA.editionRepo.getById.mockResolvedValue(makeEdition());
    mocksA.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocksA.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocksA.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocksA.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "generating", url: "https://cdn.example.com/x.mp3" }),
    );

    const svcA = createPublicationService(depsA);
    const reportA = await svcA.checkCompletion("ed-1");
    expect(reportA.podcastReady).toBe(false);
    expect(reportA.missingArtifacts).toContain("podcast not ready or no URL");

    const { deps: depsB, mocks: mocksB } = makeFakeDeps();
    mocksB.editionRepo.getById.mockResolvedValue(makeEdition());
    mocksB.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocksB.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocksB.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocksB.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: null }),
    );

    const svcB = createPublicationService(depsB);
    const reportB = await svcB.checkCompletion("ed-1");
    expect(reportB.podcastReady).toBe(false);
    expect(reportB.missingArtifacts).toContain("podcast not ready or no URL");
  });

  it("aggregates multiple missing labels in deterministic order", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(undefined);
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "pending" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "failed" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "generating", url: null }),
    );

    const svc = createPublicationService(deps);
    const report = await svc.checkCompletion("ed-1");

    expect(report.missingArtifacts).toEqual([
      "markdown digest missing or empty",
      "email not sent",
      "notebook not ready",
      "podcast not ready or no URL",
    ]);
  });

  it("throws EditionNotFoundError when the edition does not exist", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(undefined);

    const svc = createPublicationService(deps);
    await expect(svc.checkCompletion("missing")).rejects.toBeInstanceOf(
      EditionNotFoundError,
    );
  });
});

describe("publish — idempotency", () => {
  it("is a no-op against a 'published' edition and returns already_published", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "published" }),
    );

    const svc = createPublicationService(deps);
    const result = await svc.publish({ editionId: "ed-1" });

    expect(result.status).toBe("already_published");
    expect(result.alreadyExisted).toBe(true);
    expect(result.cancelledJobCount).toBe(0);
    expect(result.completion.missingArtifacts).toEqual([]);
    expect(result.completion.markdownExists).toBe(true);
    expect(result.completion.markdownNonEmpty).toBe(true);
    expect(result.completion.emailSent).toBe(true);
    expect(result.completion.notebookReady).toBe(true);
    expect(result.completion.podcastReady).toBe(true);
    expect(mocks.editionRepo.transition).not.toHaveBeenCalled();
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
    expect(mocks.markdownDigestRepo.getByEdition).not.toHaveBeenCalled();
    expect(mocks.emailDigestRepo.getByEdition).not.toHaveBeenCalled();
    expect(mocks.notebookRepo.getByEdition).not.toHaveBeenCalled();
    expect(mocks.podcastRepo.getByEdition).not.toHaveBeenCalled();
  });

  it("is a no-op against a 'publishing' edition", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "publishing" }),
    );

    const svc = createPublicationService(deps);
    const result = await svc.publish({ editionId: "ed-1" });

    expect(result.status).toBe("publishing");
    expect(result.alreadyExisted).toBe(false);
    expect(result.cancelledJobCount).toBe(0);
    expect(mocks.editionRepo.transition).not.toHaveBeenCalled();
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
    expect(mocks.markdownDigestRepo.getByEdition).not.toHaveBeenCalled();
  });
});

describe("publish — gate and transition", () => {
  function stubAllArtifactsReady(
    mocks: FakeDeps["mocks"],
  ): void {
    mocks.editionRepo.getById.mockResolvedValue(makeEdition());
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );
  }

  it("transitions building → publishing → published, cancels jobs, returns published", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "building" }),
    );
    stubAllArtifactsReady(mocks);
    mocks.editionRepo.transition.mockImplementation(
      async (id: string, to: EditionStatus) =>
        makeEdition({ id, status: to }),
    );
    mocks.jobQueue.cancelForEdition.mockResolvedValue(7);

    const svc = createPublicationService(deps);
    const result = await svc.publish({ editionId: "ed-1" });

    expect(result.status).toBe("published");
    expect(result.alreadyExisted).toBe(false);
    expect(result.cancelledJobCount).toBe(7);
    expect(result.completion.missingArtifacts).toEqual([]);

    const transitionCalls = mocks.editionRepo.transition.mock.calls;
    expect(transitionCalls).toHaveLength(2);
    expect(transitionCalls[0]![1]).toBe("publishing");
    expect(transitionCalls[1]![1]).toBe("published");
    expect(mocks.jobQueue.cancelForEdition).toHaveBeenCalledOnce();
    expect(mocks.jobQueue.cancelForEdition).toHaveBeenCalledWith({
      editionId: "ed-1",
      reason: "cancelled by publication of edition ed-1",
    });
  });

  it("works the same way for a 'ready' edition", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "ready" }),
    );
    stubAllArtifactsReady(mocks);
    mocks.editionRepo.transition.mockImplementation(
      async (id: string, to: EditionStatus) =>
        makeEdition({ id, status: to }),
    );
    mocks.jobQueue.cancelForEdition.mockResolvedValue(3);

    const svc = createPublicationService(deps);
    const result = await svc.publish({ editionId: "ed-1" });

    expect(result.status).toBe("published");
    expect(result.alreadyExisted).toBe(false);
    expect(result.cancelledJobCount).toBe(3);
    expect(mocks.editionRepo.transition).toHaveBeenCalledTimes(2);
    expect(mocks.jobQueue.cancelForEdition).toHaveBeenCalledOnce();
  });

  it("rethrows InvalidEditionTransitionError when 'failed' cannot transition to 'publishing'", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "failed" }),
    );
    stubAllArtifactsReady(mocks);
    mocks.editionRepo.transition.mockImplementation(async () => {
      throw new InvalidEditionTransitionError("failed", "publishing");
    });

    const svc = createPublicationService(deps);
    await expect(svc.publish({ editionId: "ed-1" })).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );

    expect(mocks.editionRepo.transition).toHaveBeenCalledTimes(1);
    expect(mocks.editionRepo.transition.mock.calls[0]![1]).toBe("publishing");
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
  });

  it("throws PublicationGateFailedError when an artifact is missing; no transition or cancel", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "ready" }),
    );
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "pending" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );

    const svc = createPublicationService(deps);
    await expect(svc.publish({ editionId: "ed-1" })).rejects.toBeInstanceOf(
      PublicationGateFailedError,
    );

    await expect(svc.publish({ editionId: "ed-1" })).rejects.toThrow(
      /publication gate failed for edition ed-1: missing artifacts: email not sent/,
    );

    expect(mocks.editionRepo.transition).not.toHaveBeenCalled();
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
  });
});

describe("publish — error propagation", () => {
  it("propagates EditionNotFoundError when the edition does not exist", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(undefined);

    const svc = createPublicationService(deps);
    await expect(svc.publish({ editionId: "missing" })).rejects.toBeInstanceOf(
      EditionNotFoundError,
    );
    expect(mocks.editionRepo.transition).not.toHaveBeenCalled();
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
  });

  it("rethrows InvalidEditionTransitionError when the transition is invalid", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "ready" }),
    );
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );
    mocks.editionRepo.transition.mockImplementation(async () => {
      throw new InvalidEditionTransitionError("ready", "publishing");
    });

    const svc = createPublicationService(deps);
    await expect(svc.publish({ editionId: "ed-1" })).rejects.toBeInstanceOf(
      InvalidEditionTransitionError,
    );
    expect(mocks.jobQueue.cancelForEdition).not.toHaveBeenCalled();
  });
});

describe("publishForDate", () => {
  it("resolves the edition by date and delegates to publish", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getByDate.mockResolvedValue(
      makeEdition({ id: "ed-1" }),
    );
    mocks.editionRepo.getById.mockResolvedValue(
      makeEdition({ status: "ready" }),
    );
    mocks.markdownDigestRepo.getByEdition.mockResolvedValue(makeMarkdown());
    mocks.emailDigestRepo.getByEdition.mockResolvedValue(
      makeEmail({ delivery_status: "sent" }),
    );
    mocks.notebookRepo.getByEdition.mockResolvedValue(
      makeNotebook({ status: "ready" }),
    );
    mocks.podcastRepo.getByEdition.mockResolvedValue(
      makePodcast({ status: "ready", url: "https://cdn.example.com/x.mp3" }),
    );
    mocks.editionRepo.transition.mockImplementation(
      async (id: string, to: EditionStatus) =>
        makeEdition({ id, status: to }),
    );
    mocks.jobQueue.cancelForEdition.mockResolvedValue(0);

    const svc = createPublicationService(deps);
    const result = await svc.publishForDate({ editionDate: "2026-07-07" });

    expect(result.status).toBe("published");
    expect(mocks.editionRepo.getByDate).toHaveBeenCalledWith("2026-07-07");
    expect(mocks.editionRepo.getById).toHaveBeenCalledWith("ed-1");
  });

  it("throws when no edition exists for the date", async () => {
    const { deps, mocks } = makeFakeDeps();
    mocks.editionRepo.getByDate.mockResolvedValue(undefined);

    const svc = createPublicationService(deps);
    await expect(
      svc.publishForDate({ editionDate: "2030-01-01" }),
    ).rejects.toThrow(/no edition found for date 2030-01-01/);
  });
});
