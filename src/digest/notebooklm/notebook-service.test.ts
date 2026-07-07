import { describe, it, expect, vi } from "vitest";
import {
  createNotebookService,
  type NotebookServiceConfig,
  type NotebookServiceDeps,
} from "./notebook-service.js";
import {
  NotebookConflictError,
  type NotebookRepository,
  type NotebookRow,
} from "./notebook-repository.js";
import type { MarkdownDigestRow } from "../markdown/markdown-digest-repository.js";
import type { DocumentRow } from "../../expansion/document-repository.js";
import type { Edition } from "../../database/kysely.js";
import type { Logger } from "../../logging/logger.js";
import {
  NotebookLmError,
  type CreateNotebookResult,
  type AddSourceResult,
  type NotebookLmClient,
  type WaitSourceResult,
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

function makeMarkdown(
  content = "# Daily Digest — 2026-07-07\n\nBody.\n",
): MarkdownDigestRow {
  return {
    id: "md-1",
    edition_id: "ed-1",
    content,
    story_count: 1,
    document_count: 2,
    citation_count: 3,
    created_at: new Date(),
  };
}

function makeDoc(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc-1",
    edition_id: "ed-1",
    source_type: "article",
    source_url: "https://example.com/article",
    canonical_url: "https://example.com/article",
    title: "Test Article",
    subtitle: null,
    authors: null,
    publisher: null,
    published_at: null,
    language: "en",
    content_markdown: null,
    content_text: null,
    metadata: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeNotebookRow(overrides: Partial<NotebookRow> = {}): NotebookRow {
  return {
    id: "nb-row-1",
    edition_id: "ed-1",
    notebook_external_id: "nb-ext-1",
    title: "Daily Digest — 2026-07-07",
    url: "https://notebooklm.google.com/notebook/nb-ext-1",
    source_count: 0,
    status: "pending",
    provider_response: null,
    created_at: new Date(),
    completed_at: null,
    ...overrides,
  };
}

function makeFakeNotebookLmClient(opts: {
  createResult?: CreateNotebookResult;
  createThrows?: Error;
  addSourceResults?: AddSourceResult[];
  addSourceOverride?: (input: unknown) => AddSourceResult;
  waitResults?: WaitSourceResult[];
} = {}): NotebookLmClient & {
  createNotebook: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  waitForSource: ReturnType<typeof vi.fn>;
} {
  const addSourceFn = vi.fn(async (input: unknown) => {
    if (opts.addSourceOverride) return opts.addSourceOverride(input);
    const queue = opts.addSourceResults ?? [];
    const next = queue.shift();
    if (!next) {
      return {
        sourceExternalId: `src-${Math.random().toString(36).slice(2)}`,
        title: null,
        kind: null,
        url: null,
        status: "processing",
      } satisfies AddSourceResult;
    }
    return next;
  });
  const waitFn = vi.fn(
    async (_input: {
      notebookExternalId: string;
      sourceExternalId: string;
      timeoutSec?: number;
      pollIntervalMs?: number;
    }): Promise<WaitSourceResult> => {
      const queue = opts.waitResults ?? [
        { status: "ready" as const, attempts: 1 },
      ];
      return queue.shift() ?? { status: "ready" as const, attempts: 1 };
    },
  );
  return {
    createNotebook: vi.fn(async () => {
      if (opts.createThrows) throw opts.createThrows;
      return (
        opts.createResult ?? {
          notebookExternalId: "nb-ext-1",
          title: "Daily Digest — 2026-07-07",
          url: "https://notebooklm.google.com/notebook/nb-ext-1",
          createdAt: "2026-07-07T00:00:00Z",
        }
      );
    }),
    addSource: addSourceFn,
    waitForSource: waitFn,
    generateAudio: vi.fn(),
    waitForArtifact: vi.fn(),
    downloadAudio: vi.fn(),
    authCheck: vi.fn(),
    listNotebooks: vi.fn(),
  };
}

interface DepsOverrides {
  edition?: Edition | undefined;
  notebookLm?: NotebookLmClient;
  existingNotebookRow?: NotebookRow | undefined;
  markdownRow?: MarkdownDigestRow | undefined;
  documents?: DocumentRow[];
  titleTemplate?: (d: string) => string;
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
  const defaultEdition = makeEdition();
  const defaultMarkdown = makeMarkdown();
  const documents = overrides.documents ?? [
    makeDoc({
      id: "doc-1",
      title: "Article One",
      source_url: "https://example.com/one",
      canonical_url: "https://example.com/one",
    }),
    makeDoc({
      id: "doc-2",
      title: "Article Two",
      source_type: "article",
      source_url: "https://example.com/two",
      canonical_url: "https://example.com/two",
    }),
  ];

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
  const docRepo = {
    getByEdition: vi.fn().mockResolvedValue(documents),
  };
  const notebookRepo = {
    getByEdition: vi.fn().mockImplementation(async () => overrides.existingNotebookRow),
    createForEdition: vi
      .fn()
      .mockImplementation(
        async (input: Parameters<NotebookRepository["createForEdition"]>[0]) =>
          makeNotebookRow({
            id: "nb-row-1",
            edition_id: input.editionId,
            notebook_external_id: input.notebookExternalId,
            title: input.title,
            url: input.url,
            source_count: input.sourceCount ?? 0,
            status: input.status ?? "pending",
            provider_response: input.providerResponse ?? null,
          }),
      ),
    updateDelivery: vi
      .fn()
      .mockImplementation(
        async (id: string, update: Parameters<NotebookRepository["updateDelivery"]>[1]) =>
          makeNotebookRow({
            id,
            status: update.status ?? "pending",
            source_count: update.sourceCount ?? 0,
            completed_at: update.completedAt ?? null,
            provider_response: update.providerResponse ?? null,
          }),
      ),
    getById: vi.fn(),
    getByExternalId: vi.fn(),
    deleteByEdition: vi.fn(),
  };
  const notebookLm =
    overrides.notebookLm ?? makeFakeNotebookLmClient();

  const config: NotebookServiceConfig | undefined = overrides.titleTemplate
    ? { titleTemplate: overrides.titleTemplate }
    : undefined;

  const deps: NotebookServiceDeps = {
    db: {} as never,
    editionRepo: editionRepo as never,
    markdownDigestRepo: markdownDigestRepo as never,
    docRepo: docRepo as never,
    notebookRepo: notebookRepo as never,
    notebookLm,
    ...(config !== undefined ? { config } : {}),
    logger: silentLogger(),
  };

  return {
    deps,
    mocks: {
      editionRepo,
      markdownDigestRepo,
      docRepo,
      notebookRepo,
      notebookLm,
    },
  };
}

describe("generate — happy path", () => {
  it("uploads every document then the markdown digest, waits for all, marks ready", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(result.sourceCount).toBe(3);
    expect(result.notebookId).toBe("nb-row-1");

    const order = (
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    expect(order).toBeGreaterThan(0);

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(3);
    expect(addSourceCalls[0]![0]).toMatchObject({
      notebookExternalId: "nb-ext-1",
      url: "https://example.com/one",
      displayName: "Article One",
    });
    expect(addSourceCalls[1]![0]).toMatchObject({
      notebookExternalId: "nb-ext-1",
      url: "https://example.com/two",
      displayName: "Article Two",
    });
    expect(addSourceCalls[2]![0]).toMatchObject({
      notebookExternalId: "nb-ext-1",
      markdownContent: "# Daily Digest — 2026-07-07\n\nBody.\n",
      displayName: "Daily Digest 2026-07-07",
    });

    const waitCalls = (mocks.notebookLm.waitForSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(waitCalls).toHaveLength(3);

    const updateCalls = (mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    const readyCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    );
    expect(readyCall).toBeDefined();
    expect(readyCall![1]).toMatchObject({
      status: "ready",
      sourceCount: 3,
    });
  });

  it("passes the templated title to createNotebook when titleTemplate is configured", async () => {
    const { deps, mocks } = makeDeps({
      titleTemplate: (d) => `PNIP ${d}`,
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const arg = (
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(arg.title).toBe("PNIP 2026-07-07");
  });

  it("uses canonical_url when present and falls back to source_url otherwise", async () => {
    const { deps, mocks } = makeDeps({
      documents: [
        makeDoc({
          id: "doc-1",
          title: "Canonical",
          source_url: "https://tracker.example.com/r/123",
          canonical_url: "https://example.com/canonical",
        }),
        makeDoc({
          id: "doc-2",
          title: "NoCanonical",
          source_url: "https://example.com/no-canonical",
          canonical_url: null,
        }),
      ],
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const calls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0]![0]).toMatchObject({
      url: "https://example.com/canonical",
    });
    expect(calls[1]![0]).toMatchObject({
      url: "https://example.com/no-canonical",
    });
  });

  it("uploads PDF documents via filePath when metadata.local_path is set", async () => {
    const { deps, mocks } = makeDeps({
      documents: [
        makeDoc({
          id: "doc-1",
          title: "PDF Paper",
          source_type: "pdf",
          source_url: "https://example.com/paper.pdf",
          canonical_url: "https://example.com/paper.pdf",
          metadata: { local_path: "/tmp/paper.pdf" } as never,
        }),
      ],
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const calls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0]![0]).toMatchObject({
      filePath: "/tmp/paper.pdf",
      displayName: "PDF Paper",
    });
    expect(calls[0]![0].url).toBeUndefined();
  });

  it("falls back to URL upload for PDFs without metadata.local_path", async () => {
    const { deps, mocks } = makeDeps({
      documents: [
        makeDoc({
          id: "doc-1",
          title: "PDF NoLocal",
          source_type: "pdf",
          source_url: "https://example.com/paper.pdf",
          canonical_url: "https://example.com/paper.pdf",
          metadata: null,
        }),
      ],
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const calls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0]![0]).toMatchObject({
      url: "https://example.com/paper.pdf",
    });
  });
});

describe("generate — idempotency", () => {
  it("returns alreadyExisted=true and skips createNotebook when existing row is 'ready'", async () => {
    const existing = makeNotebookRow({
      id: "nb-existing",
      status: "ready",
      notebook_external_id: "nb-ext-existing",
      url: "https://notebooklm.google.com/notebook/nb-ext-existing",
      source_count: 5,
      completed_at: new Date(),
    });
    const { deps, mocks } = makeDeps({ existingNotebookRow: existing });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.notebookId).toBe("nb-existing");
    expect(result.sourceCount).toBe(5);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(
      (mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("continues and re-creates the notebook when existing row is 'failed'", async () => {
    const existing = makeNotebookRow({
      id: "nb-old",
      status: "failed",
      notebook_external_id: "nb-ext-old",
      url: "https://notebooklm.google.com/notebook/nb-ext-old",
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: existing,
      notebookLm: makeFakeNotebookLmClient({
        createResult: {
          notebookExternalId: "nb-ext-new",
          title: "Daily Digest — 2026-07-07",
          url: "https://notebooklm.google.com/notebook/nb-ext-new",
          createdAt: "2026-07-07T00:00:00Z",
        },
      }),
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });
});

describe("generate — validation errors", () => {
  it("throws when the markdown digest is missing", async () => {
    const { deps, mocks } = makeDeps({ markdownRow: undefined });
    const svc = createNotebookService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /no markdown digest/,
    );
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws when there are zero curated documents", async () => {
    const { deps, mocks } = makeDeps({ documents: [] });
    const svc = createNotebookService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /no curated source documents/,
    );
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws when every document is missing both canonical_url and source_url", async () => {
    const { deps, mocks } = makeDeps({
      documents: [
        makeDoc({ id: "doc-x", source_url: "", canonical_url: null }),
      ],
    });
    const svc = createNotebookService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /no curated source documents/,
    );
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("throws 'edition not found' when the edition id is unknown", async () => {
    const { deps } = makeDeps({ edition: undefined });
    const svc = createNotebookService(deps);
    await expect(svc.generate({ editionId: "missing" })).rejects.toThrow(
      /edition not found/,
    );
  });
});

describe("generate — createNotebook failure", () => {
  it("persists the row in 'failed' state with the NotebookLmError message and re-throws", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      createThrows: new NotebookLmError({
        message: "notebooklm auth missing",
        command: "notebooklm create X --json",
        exitCode: 1,
        stderr: "auth missing",
        stdout: null,
        durationMs: 10,
        timedOut: false,
      }),
    });
    const { deps, mocks } = makeDeps({ notebookLm });
    const svc = createNotebookService(deps);
    await expect(svc.generate({ editionId: "ed-1", wait: true })).rejects.toThrow(
      /notebooklm auth missing/,
    );
    const updateCalls = (mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mock
      .calls;
    const createCalls = (mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>).mock
      .calls;
    const recordedFailed =
      updateCalls.some(([, u]) => (u as { status?: string }).status === "failed") ||
      createCalls.some(
        (c) => (c[0] as { status?: string }).status === "failed",
      );
    expect(recordedFailed).toBe(true);
  });
});

describe("generate — waitForSource failure", () => {
  it("marks the row failed and returns {status:'failed'} (does NOT re-throw) when a source reports error", async () => {
    const notebookLm = makeFakeNotebookLmClient({
      waitResults: [
        { status: "ready", attempts: 1 },
        { status: "error", attempts: 1 },
        { status: "ready", attempts: 1 },
      ],
    });
    const { deps, mocks } = makeDeps({
      notebookLm,
      documents: [
        makeDoc({
          id: "doc-1",
          title: "Article One",
          source_url: "https://example.com/one",
          canonical_url: "https://example.com/one",
        }),
        makeDoc({
          id: "doc-2",
          title: "Article Two",
          source_url: "https://example.com/two",
          canonical_url: "https://example.com/two",
        }),
      ],
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.status).toBe("failed");
    expect(result.alreadyExisted).toBe(false);
    expect(result.failureReason).toMatch(/src-/);
    expect(result.failureReason).toMatch(/Article Two/);
    const updateCalls = (mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(updateCalls.some(([, u]) => (u as { status?: string }).status === "failed")).toBe(
      true,
    );
  });
});

describe("generate — UNIQUE race recovery", () => {
  it("recovers to alreadyExisted=true when createForEdition conflicts and the existing row is 'ready'", async () => {
    const readyExisting = makeNotebookRow({
      id: "nb-existing",
      status: "ready",
      notebook_external_id: "nb-ext-existing",
      url: "https://notebooklm.google.com/notebook/nb-ext-existing",
      source_count: 7,
      completed_at: new Date(),
    });
    let getByEditionCalls = 0;
    const notebookRepo = {
      getByEdition: vi.fn().mockImplementation(async () => {
        getByEditionCalls++;
        if (getByEditionCalls === 1) return undefined;
        return readyExisting;
      }),
      createForEdition: vi.fn().mockImplementation(async () => {
        throw new NotebookConflictError("ed-1");
      }),
      updateDelivery: vi
        .fn()
        .mockImplementation(
          async (
            id: string,
            update: Parameters<NotebookRepository["updateDelivery"]>[1],
          ) =>
            makeNotebookRow({
              id,
              status: update.status ?? "pending",
              source_count: update.sourceCount ?? 0,
              completed_at: update.completedAt ?? null,
              provider_response: update.providerResponse ?? null,
            }),
        ),
      getById: vi.fn(),
      getByExternalId: vi.fn(),
      deleteByEdition: vi.fn(),
    };
    const { deps } = makeDeps({
      existingNotebookRow: undefined,
    });
    deps.notebookRepo = notebookRepo as never;
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.notebookId).toBe("nb-existing");
  });

  it("recovers the existing pending row and polls to ready when wait: true and the row has a valid provider_response", async () => {
    const pendingExisting = makeNotebookRow({
      id: "nb-existing",
      status: "pending",
      source_count: 2,
      notebook_external_id: "nb-ext-existing",
      provider_response: {
        phase: "pending",
        createNotebook: {
          notebookExternalId: "nb-ext-existing",
          title: "Daily Digest",
          url: "https://notebooklm.google.com/notebook/nb-ext-existing",
          createdAt: null,
        },
        uploadedSources: [
          { sourceExternalId: "src-1", docId: null, displayName: "src 1" },
          { sourceExternalId: "src-2", docId: null, displayName: "src 2" },
        ],
      },
    });
    const notebookLm = makeFakeNotebookLmClient({
      waitResults: [
        { status: "ready", attempts: 1 },
        { status: "ready", attempts: 1 },
      ],
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: pendingExisting,
      notebookLm,
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(2);
    expect(
      mocks.notebookLm.createNotebook,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.waitForSource as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(2);
  });

  it("deletes a 'failed' row and creates a fresh notebook when re-run", async () => {
    const failedExisting = makeNotebookRow({
      id: "nb-existing",
      status: "failed",
      notebook_external_id: "nb-ext-stale",
    });
    const freshRow = makeNotebookRow({
      id: "nb-new",
      status: "pending",
      notebook_external_id: "nb-ext-fresh",
      url: "https://notebooklm.google.com/notebook/nb-ext-fresh",
    });
    const notebookLm = makeFakeNotebookLmClient({
      createResult: {
        notebookExternalId: "nb-ext-fresh",
        title: "Daily Digest",
        url: "https://notebooklm.google.com/notebook/nb-ext-fresh",
        createdAt: null,
      },
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: failedExisting,
      notebookLm,
    });
    let created = true;
    (deps.notebookRepo.createForEdition as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        if (created) {
          created = false;
          return freshRow;
        }
        throw new NotebookConflictError("ed-1");
      },
    );
    (deps.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id, update) =>
        makeNotebookRow({
          id: freshRow.id,
          notebook_external_id: freshRow.notebook_external_id,
          title: freshRow.title,
          url: freshRow.url,
          status: update.status ?? freshRow.status,
          source_count: update.sourceCount ?? freshRow.source_count,
          completed_at: update.completedAt ?? null,
          provider_response: update.providerResponse ?? null,
        }),
    );
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });
    expect(result.alreadyExisted).toBe(false);
    expect(result.notebookExternalId).toBe("nb-ext-fresh");
    expect(
      mocks.notebookRepo.deleteByEdition as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
  });
});

describe("generate — fire-and-forget (default)", () => {
  it("returns immediately with status=pending, mode=fire-and-forget, no waitForSource calls", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });

    expect(result.status).toBe("pending");
    expect(result.alreadyExisted).toBe(false);
    expect(result.mode).toBe("fire-and-forget");
    expect(result.sourceCount).toBeGreaterThan(0);
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalled();
    expect(
      mocks.notebookLm.waitForSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("is a no-op for an existing 'pending' notebook (does not re-upload sources)", async () => {
    const pendingExisting = makeNotebookRow({
      id: "nb-existing",
      status: "pending",
      source_count: 2,
      notebook_external_id: "nb-ext-existing",
      provider_response: {
        phase: "pending",
        createNotebook: {
          notebookExternalId: "nb-ext-existing",
          title: "Daily Digest",
          url: "https://notebooklm.google.com/notebook/nb-ext-existing",
          createdAt: null,
        },
        uploadedSources: [
          { sourceExternalId: "src-1", docId: null, displayName: "src 1" },
        ],
      },
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: pendingExisting,
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.mode).toBe("fire-and-forget");
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("is a no-op for an existing 'ready' notebook", async () => {
    const readyExisting = makeNotebookRow({
      id: "nb-existing",
      status: "ready",
      source_count: 4,
      notebook_external_id: "nb-ext-existing",
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: readyExisting,
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.status).toBe("ready");
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("persists the uploaded source IDs in provider_response.uploadedSources for later --wait recovery", async () => {
    const freshRow = makeNotebookRow({
      id: "nb-fresh",
      status: "pending",
      notebook_external_id: "nb-ext-fresh",
    });
    const { deps, mocks } = makeDeps();
    (deps.notebookRepo.createForEdition as ReturnType<typeof vi.fn>).mockResolvedValue(
      freshRow,
    );
    (deps.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mockImplementation(
      async (id, update) =>
        makeNotebookRow({
          id,
          status: update.status ?? "pending",
          source_count: update.sourceCount ?? 0,
          completed_at: update.completedAt ?? null,
          provider_response: update.providerResponse ?? null,
        }),
    );
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1" });
    const updateCalls = (
      mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const persistCall = updateCalls.find(
      ([, u]) => (u as { providerResponse?: { phase?: string } }).providerResponse?.phase === "pending",
    );
    expect(persistCall).toBeDefined();
    const providerState = (
      persistCall![1] as { providerResponse?: { uploadedSources?: unknown[] } }
    ).providerResponse;
    expect(providerState?.uploadedSources).toBeDefined();
    expect(Array.isArray(providerState?.uploadedSources)).toBe(true);
    expect(
      (providerState?.uploadedSources as unknown[]).length,
    ).toBeGreaterThan(0);
  });
});

describe("generateForDate", () => {
  it("resolves the edition by date then generates", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createNotebookService(deps);
    const result = await svc.generateForDate({
      editionDate: "2026-07-07",
      wait: true,
    });
    expect(result.status).toBe("ready");
    expect(
      (mocks.editionRepo.getByDate as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("2026-07-07");
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });

  it("throws when no edition exists for the date", async () => {
    const { deps } = makeDeps({ edition: undefined });
    const svc = createNotebookService(deps);
    await expect(
      svc.generateForDate({ editionDate: "2030-01-01" }),
    ).rejects.toThrow(/no edition found/);
  });
});