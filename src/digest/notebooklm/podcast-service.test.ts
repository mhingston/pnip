import { describe, it, expect, vi } from "vitest";
import {
  createPodcastService,
  type PodcastServiceConfig,
  type PodcastServiceDeps,
} from "./podcast-service.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});
import {
  PodcastConflictError,
  type PodcastRepository,
  type PodcastRow,
} from "./podcast-repository.js";
import type { NotebookRow } from "./notebook-repository.js";
import type { MarkdownDigestRow } from "../markdown/markdown-digest-repository.js";
import type { Edition } from "../../database/kysely.js";
import type { Logger } from "../../logging/logger.js";
import {
  NotebookLmError,
  type GenerateAudioResult,
  type NotebookLmClient,
  type WaitArtifactResult,
  type DownloadAudioResult,
} from "./notebooklm-client.js";

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
    created_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    failed_at: null,
    failure_reason: null,
    cluster_stories_enqueued_at: null,
    metadata: null,
    ...overrides,
  };
}

function makeMarkdown(): MarkdownDigestRow {
  return {
    id: "md-1",
    edition_id: "ed-1",
    content: "# Daily Digest — 2026-07-07\n\nBody.\n",
    story_count: 1,
    document_count: 2,
    citation_count: 3,
    created_at: new Date(),
  };
}

function makeNotebookRow(
  overrides: Partial<NotebookRow> = {},
): NotebookRow {
  return {
    id: "nb-row-1",
    edition_id: "ed-1",
    notebook_external_id: "nb-ext-1",
    title: "Daily Digest — 2026-07-07",
    url: "https://notebooklm.google.com/notebook/nb-ext-1",
    source_count: 2,
    status: "ready",
    provider_response: null,
    created_at: new Date(),
    completed_at: new Date(),
    ...overrides,
  };
}

function makePodcastRow(
  overrides: Partial<PodcastRow> = {},
): PodcastRow {
  return {
    id: "pod-row-1",
    edition_id: "ed-1",
    notebook_id: "nb-row-1",
    artifact_external_id: "artifact-1",
    url: "https://cdn.example.com/podcast.mp3",
    title: null,
    duration_seconds: 1200,
    format: "deep-dive",
    language: "en",
    status: "ready",
    local_path: "/tmp/podcasts/ed-1.mp3",
    provider_response: null,
    failure_reason: null,
    started_at: new Date(),
    completed_at: new Date(),
    created_at: new Date(),
    ...overrides,
  };
}

function makeFakeNotebookLmClient(opts: {
  generateResult?: GenerateAudioResult;
  generateThrows?: Error;
  waitResult?: WaitArtifactResult;
  downloadResult?: DownloadAudioResult;
  downloadThrows?: Error;
} = {}): NotebookLmClient & {
  generateAudio: ReturnType<typeof vi.fn>;
  waitForArtifact: ReturnType<typeof vi.fn>;
  downloadAudio: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async (_input: unknown): Promise<GenerateAudioResult> => {
    if (opts.generateThrows) throw opts.generateThrows;
    return (
      opts.generateResult ?? {
        taskId: "artifact-1",
        status: "completed",
        url: "https://cdn.example.com/podcast.mp3",
      }
    );
  });
  const wait = vi.fn(
    async (_input: unknown): Promise<WaitArtifactResult> =>
      opts.waitResult ?? {
        status: "completed",
        url: "https://cdn.example.com/podcast.mp3",
        attempts: 1,
      },
  );
  const download = vi.fn(
    async (_input: unknown): Promise<DownloadAudioResult> => {
      if (opts.downloadThrows) throw opts.downloadThrows;
      return (
        opts.downloadResult ?? {
          destinationPath: "/var/out/podcasts/ed-1.mp3",
          bytes: 1024,
        }
      );
    },
  );
  return {
    createNotebook: vi.fn(),
    addSource: vi.fn(),
    waitForSource: vi.fn(),
    generateAudio: generate,
    waitForArtifact: wait,
    downloadAudio: download,
    authCheck: vi.fn(),
    listNotebooks: vi.fn(),
  };
}

interface DepsOverrides {
  edition?: Edition | undefined;
  markdownRow?: MarkdownDigestRow | undefined;
  notebookRow?: NotebookRow | undefined;
  existingPodcastRow?: PodcastRow | undefined;
  notebookLm?: NotebookLmClient;
  createThrows?: Error;
  config?: PodcastServiceConfig;
}

function makeDeps(overrides: DepsOverrides = {}) {
  const hasEditionOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "edition",
  );
  const hasMarkdownOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "markdownRow",
  );
  const hasNotebookOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "notebookRow",
  );
  const hasExistingPodcastOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "existingPodcastRow",
  );
  const defaultEdition = makeEdition();
  const defaultMarkdown = makeMarkdown();
  const defaultNotebook = makeNotebookRow();

  const editionRepo = {
    getById: vi.fn().mockImplementation(async () =>
      hasEditionOverride ? overrides.edition : defaultEdition,
    ),
    getByDate: vi.fn().mockImplementation(async () =>
      hasEditionOverride ? overrides.edition : defaultEdition,
    ),
  };
  const markdownDigestRepo = {
    getByEdition: vi.fn().mockImplementation(async () =>
      hasMarkdownOverride ? overrides.markdownRow : defaultMarkdown,
    ),
  };
  const notebookRepo = {
    getByEdition: vi.fn().mockImplementation(async () =>
      hasNotebookOverride ? overrides.notebookRow : defaultNotebook,
    ),
  };
  const podcastRepo = {
    getByEdition: vi
      .fn()
      .mockImplementation(
        async () => overrides.existingPodcastRow,
      ),
    createForEdition: vi
      .fn()
      .mockImplementation(
        async (input: Parameters<PodcastRepository["createForEdition"]>[0]) =>
          makePodcastRow({
            id: "pod-row-1",
            edition_id: input.editionId,
            notebook_id: input.notebookId,
            artifact_external_id: input.artifactExternalId,
            title: input.title ?? null,
            format: input.format ?? null,
            language: input.language ?? null,
            status: input.status ?? "pending",
            failure_reason: input.failureReason ?? null,
            started_at: input.startedAt ?? null,
            provider_response: input.providerResponse ?? null,
          }),
      ),
    getById: vi.fn(),
    getByArtifactExternalId: vi.fn(),
    updateDelivery: vi
      .fn()
      .mockImplementation(
        async (
          id: string,
          update: Parameters<PodcastRepository["updateDelivery"]>[1],
        ) =>
          makePodcastRow({
            id,
            status: update.status ?? "pending",
            url: update.url === undefined ? null : update.url,
            local_path:
              update.localPath === undefined ? null : update.localPath,
            failure_reason:
              update.failureReason === undefined ? null : update.failureReason,
            started_at:
              update.startedAt === undefined ? null : update.startedAt,
            completed_at:
              update.completedAt === undefined ? null : update.completedAt,
            artifact_external_id:
              update.artifactExternalId ?? "artifact-1",
            provider_response:
              update.providerResponse === undefined
                ? null
                : update.providerResponse,
          }),
      ),
    deleteByEdition: vi.fn(),
  };
  const notebookLm =
    overrides.notebookLm ?? makeFakeNotebookLmClient();

  const deps: PodcastServiceDeps = {
    db: {} as never,
    editionRepo: editionRepo as never,
    markdownDigestRepo: markdownDigestRepo as never,
    notebookRepo: notebookRepo as never,
    podcastRepo: podcastRepo as never,
    notebookLm,
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    logger: silentLogger(),
  };

  return {
    deps,
    mocks: {
      editionRepo,
      markdownDigestRepo,
      notebookRepo,
      podcastRepo,
      notebookLm,
    },
  };
}

describe("generate — happy path", () => {
  it("persists a pending row, generates audio, downloads, and marks ready", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(result.url).toBe("https://cdn.example.com/podcast.mp3");
    expect(result.localPath).toBe("/var/out/podcasts/ed-1.mp3");
    expect(result.podcastId).toBe("pod-row-1");
    expect(result.artifactExternalId).toBe("artifact-1");

    const generateCalls = (
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]![0]).toMatchObject({
      notebookExternalId: "nb-ext-1",
      wait: true,
    });

    const createCalls = (
      mocks.podcastRepo.createForEdition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![0]).toMatchObject({
      status: "pending",
      notebookId: "nb-row-1",
    });

    const updateCalls = (
      mocks.podcastRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const updateStatuses = updateCalls.map(
      ([, u]) => (u as { status?: string }).status,
    );
    expect(updateStatuses).toContain("generating");
    expect(updateStatuses).toContain("ready");
    const finalReady = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    )!;
    expect(finalReady[1]).toMatchObject({
      url: "https://cdn.example.com/podcast.mp3",
      localPath: "/var/out/podcasts/ed-1.mp3",
    });

    expect(
      (mocks.notebookLm.downloadAudio as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });

  it("calls downloadAudio with the configured outputDir and the editionId in the filename", async () => {
    const { deps, mocks } = makeDeps({
      config: { outputDir: "/var/audio/notes" },
    });
    const svc = createPodcastService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const downloadCall = (
      mocks.notebookLm.downloadAudio as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as {
      destinationPath: string;
      artifactExternalId: string;
      notebookExternalId: string;
    };
    expect(downloadCall.destinationPath).toBe("/var/audio/notes/ed-1.mp3");
    expect(downloadCall.artifactExternalId).toBe("artifact-1");
    expect(downloadCall.notebookExternalId).toBe("nb-ext-1");
  });
});

describe("generate — outputDir default", () => {
  it("falls back to process.env.NOTEBOOKLM_OUTPUT_DIR when set", async () => {
    const prev = process.env.NOTEBOOKLM_OUTPUT_DIR;
    process.env.NOTEBOOKLM_OUTPUT_DIR = "/env/audio/out";
    try {
      const { deps, mocks } = makeDeps();
      const svc = createPodcastService(deps);
      await svc.generate({ editionId: "ed-1", wait: true });
      const downloadCall = (
        mocks.notebookLm.downloadAudio as ReturnType<typeof vi.fn>
      ).mock.calls[0]![0] as { destinationPath: string };
      expect(downloadCall.destinationPath).toBe(
        "/env/audio/out/ed-1.mp3",
      );
    } finally {
      if (prev === undefined) delete process.env.NOTEBOOKLM_OUTPUT_DIR;
      else process.env.NOTEBOOKLM_OUTPUT_DIR = prev;
    }
  });

  it("falls back to ./notebooks when env var is unset", async () => {
    const prev = process.env.NOTEBOOKLM_OUTPUT_DIR;
    delete process.env.NOTEBOOKLM_OUTPUT_DIR;
    try {
      const { deps, mocks } = makeDeps();
      const svc = createPodcastService(deps);
      await svc.generate({ editionId: "ed-1", wait: true });
      const downloadCall = (
        mocks.notebookLm.downloadAudio as ReturnType<typeof vi.fn>
      ).mock.calls[0]![0] as { destinationPath: string };
      expect(downloadCall.destinationPath).toMatch(
        /notebooks[\\/]+ed-1\.mp3$/,
      );
    } finally {
      if (prev !== undefined) process.env.NOTEBOOKLM_OUTPUT_DIR = prev;
    }
  });
});

describe("generate — config defaults", () => {
  it("passes format, length, and language from config to generateAudio", async () => {
    const { deps, mocks } = makeDeps({
      config: {
        format: "brief",
        length: "short",
        language: "fr",
        instructions: "Talk like a pirate",
        artifactWaitTimeoutSec: 60,
      },
    });
    const svc = createPodcastService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const arg = (
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(arg).toMatchObject({
      format: "brief",
      length: "short",
      language: "fr",
      instructions: "Talk like a pirate",
      wait: true,
      timeoutSec: 60,
    });
  });

  it("uses sensible defaults when no config is provided", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createPodcastService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const arg = (
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(arg.format).toBe("deep-dive");
    expect(arg.length).toBe("default");
    expect(arg.language).toBeUndefined();
    expect(typeof arg.instructions).toBe("string");
    expect(arg.instructions.length).toBeGreaterThan(0);
  });
});

describe("generate — validation errors", () => {
  it("throws when the edition does not exist", async () => {
    const { deps } = makeDeps({ edition: undefined });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "missing" })).rejects.toThrow(
      /edition not found/,
    );
  });

  it("throws when the markdown digest is missing", async () => {
    const { deps, mocks } = makeDeps({ markdownRow: undefined });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /no markdown digest for edition/,
    );
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws when the notebook is missing", async () => {
    const { deps, mocks } = makeDeps({ notebookRow: undefined });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /no notebook for edition/,
    );
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws when the notebook is in 'pending' status (sources not yet ingested)", async () => {
    const { deps, mocks } = makeDeps({
      notebookRow: makeNotebookRow({ status: "pending" }),
    });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /status 'pending'; audio generation requires all sources to be ingested/,
    );
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws when the notebook is in 'failed' status", async () => {
    const { deps, mocks } = makeDeps({
      notebookRow: makeNotebookRow({ status: "failed" }),
    });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /status 'failed'/,
    );
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });
});

describe("generate — idempotency", () => {
  it("returns alreadyExisted=true and skips generateAudio when existing row is 'ready' with a URL", async () => {
    const existing = makePodcastRow({
      id: "pod-existing",
      status: "ready",
      url: "https://cdn.example.com/already.mp3",
      artifact_external_id: "artifact-old",
      local_path: "/tmp/already.mp3",
    });
    const { deps, mocks } = makeDeps({ existingPodcastRow: existing });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.podcastId).toBe("pod-existing");
    expect(result.url).toBe("https://cdn.example.com/already.mp3");
    expect(result.localPath).toBe("/tmp/already.mp3");
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(
      (mocks.podcastRepo.createForEdition as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("continues and re-fetches via waitForArtifact when existing row is 'ready' but URL is missing", async () => {
    const existing = makePodcastRow({
      id: "pod-recovery",
      status: "ready",
      url: null,
      artifact_external_id: "artifact-recovery",
    });
    const notebookLm = makeFakeNotebookLmClient({
      generateResult: {
        taskId: "artifact-recovery",
        status: "pending",
        url: null,
      },
      waitResult: {
        status: "completed",
        url: "https://cdn.example.com/recovered.mp3",
        attempts: 1,
      },
    });
    const { deps, mocks } = makeDeps({
      existingPodcastRow: existing,
      notebookLm,
    });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(false);
    expect(result.status).toBe("ready");
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    expect(
      (mocks.notebookLm.waitForArtifact as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    const updateCalls = (
      mocks.podcastRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const readyCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    );
    expect(readyCall).toBeDefined();
  });

  it("continues and retries when the existing row is 'failed'", async () => {
    const existing = makePodcastRow({
      id: "pod-failed",
      status: "failed",
      url: null,
      artifact_external_id: "artifact-failed",
      failure_reason: "old reason",
    });
    const { deps, mocks } = makeDeps({ existingPodcastRow: existing });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    expect(
      (mocks.podcastRepo.createForEdition as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("continues and retries when the existing row is 'pending'", async () => {
    const existing = makePodcastRow({
      id: "pod-pending",
      status: "pending",
      url: null,
      artifact_external_id: "artifact-pending",
    });
    const { deps, mocks } = makeDeps({ existingPodcastRow: existing });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });
});

describe("generate — generateAudio failure", () => {
  it("marks the row 'failed' with the NotebookLmError message and re-throws", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      generateThrows: new NotebookLmError({
        message: "audio generation failed",
        command: "notebooklm generate audio",
        exitCode: 1,
        stderr: "auth expired",
        stdout: null,
        durationMs: 1234,
        timedOut: false,
      }),
    });
    const { deps, mocks } = makeDeps({ notebookLm });
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /audio generation failed/,
    );
    const updateCalls = (
      mocks.podcastRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const failedCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "failed",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1]).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("audio generation failed"),
    });
  });
});

describe("generate — UNIQUE race", () => {
  it("recovers to alreadyExisted=true when createForEdition conflicts and the existing row is 'ready' with a URL", async () => {
    const readyExisting = makePodcastRow({
      id: "pod-existing",
      status: "ready",
      url: "https://cdn.example.com/already.mp3",
    });
    let getByEditionCalls = 0;
    const podcastRepo = {
      getByEdition: vi.fn().mockImplementation(async () => {
        getByEditionCalls++;
        if (getByEditionCalls === 1) return undefined;
        return readyExisting;
      }),
      createForEdition: vi.fn().mockImplementation(async () => {
        throw new PodcastConflictError("ed-1");
      }),
      getById: vi.fn(),
      getByArtifactExternalId: vi.fn(),
      updateDelivery: vi.fn(),
      deleteByEdition: vi.fn(),
    };
    const { deps } = makeDeps({ existingPodcastRow: undefined });
    deps.podcastRepo = podcastRepo as never;
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.podcastId).toBe("pod-existing");
  });

  it("re-throws when createForEdition conflicts and the existing row is 'failed'", async () => {
    const failedExisting = makePodcastRow({
      id: "pod-existing",
      status: "failed",
      url: null,
    });
    let getByEditionCalls = 0;
    const podcastRepo = {
      getByEdition: vi.fn().mockImplementation(async () => {
        getByEditionCalls++;
        if (getByEditionCalls === 1) return undefined;
        return failedExisting;
      }),
      createForEdition: vi.fn().mockImplementation(async () => {
        throw new PodcastConflictError("ed-1");
      }),
      getById: vi.fn(),
      getByArtifactExternalId: vi.fn(),
      updateDelivery: vi.fn(),
      deleteByEdition: vi.fn(),
    };
    const { deps } = makeDeps({ existingPodcastRow: undefined });
    deps.podcastRepo = podcastRepo as never;
    const svc = createPodcastService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toBeInstanceOf(
      PodcastConflictError,
    );
  });
});

describe("generateForDate", () => {
  it("resolves the edition via getByDate then generates", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createPodcastService(deps);
    const result = await svc.generateForDate({
      editionDate: "2026-07-07",
      wait: true,
    });
    expect(result.status).toBe("ready");
    expect(
      (mocks.editionRepo.getByDate as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("2026-07-07");
    expect(
      (mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });

  it("throws when no edition exists for the date", async () => {
    const { deps } = makeDeps({ edition: undefined });
    const svc = createPodcastService(deps);
    await expect(
      svc.generateForDate({ editionDate: "2030-01-01" }),
    ).rejects.toThrow(/no edition found/);
  });
});

describe("generate — download failure", () => {
  it("marks the row ready with the URL but localPath=null and failureReason set", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      downloadThrows: new Error("disk full"),
    });
    const { deps, mocks } = makeDeps({ notebookLm });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.status).toBe("ready");
    expect(result.url).toBe("https://cdn.example.com/podcast.mp3");
    expect(result.localPath).toBeNull();
    expect(result.failureReason).toMatch(/disk full/);

    const updateCalls = (
      mocks.podcastRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const readyCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    )!;
    expect(readyCall[1]).toMatchObject({
      status: "ready",
      url: "https://cdn.example.com/podcast.mp3",
    });
    expect(
      (readyCall[1] as { localPath?: unknown }).localPath,
    ).toBeUndefined();
    expect(
      (readyCall[1] as { failureReason?: unknown }).failureReason,
    ).toMatch(/disk full/);
  });
});

describe("generate — fire-and-forget (default)", () => {
  it("returns immediately with status=generating and a taskId, no download", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      generateResult: {
        taskId: "artifact-fire-and-forget",
        status: "pending",
        url: null,
      },
    });
    const { deps, mocks } = makeDeps({ notebookLm });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1" });

    expect(result.status).toBe("generating");
    expect(result.alreadyExisted).toBe(false);
    expect(result.artifactExternalId).toBe("artifact-fire-and-forget");
    expect(result.url).toBeNull();
    expect(result.localPath).toBeNull();
    expect(result.failureReason).toMatch(/fire-and-forget/);

    const generateCalls = (
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]![0]).toMatchObject({ wait: false });
    expect(
      mocks.notebookLm.waitForArtifact,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.downloadAudio,
    ).not.toHaveBeenCalled();
  });

  it("returns immediately when an existing 'generating' row is re-run with no wait", async () => {
    const existing = makePodcastRow({
      id: "pod-in-progress",
      status: "generating",
      url: null,
      artifact_external_id: "artifact-1",
    });
    const notebookLm = makeFakeNotebookLmClient({
      generateResult: {
        taskId: "artifact-1",
        status: "pending",
        url: null,
      },
    });
    const { deps, mocks } = makeDeps({
      existingPodcastRow: existing,
      notebookLm,
    });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.status).toBe("generating");
    expect(result.artifactExternalId).toBe("artifact-1");
    expect(
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
  });

  it("does NOT short-circuit a 'ready' row even when wait is false", async () => {
    const existing = makePodcastRow({
      id: "pod-already-ready",
      status: "ready",
      url: "https://cdn.example.com/already.mp3",
    });
    const { deps, mocks } = makeDeps({ existingPodcastRow: existing });
    const svc = createPodcastService(deps);
    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(
      mocks.notebookLm.generateAudio as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("persists the row as 'generating' with startedAt and artifact id", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      generateResult: {
        taskId: "artifact-pending",
        status: "pending",
        url: null,
      },
    });
    const { deps, mocks } = makeDeps({ notebookLm });
    const svc = createPodcastService(deps);
    await svc.generate({ editionId: "ed-1" });
    const updateCalls = (
      mocks.podcastRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const generatingCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "generating",
    );
    expect(generatingCall).toBeDefined();
    expect(
      (generatingCall![1] as { artifactExternalId?: string })
        .artifactExternalId,
    ).toBe("artifact-pending");
    expect(
      (generatingCall![1] as { startedAt?: Date }).startedAt,
    ).toBeInstanceOf(Date);
  });
});