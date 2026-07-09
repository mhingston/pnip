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
    partition_key: "master",
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
    partition_key: "master",
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
    partition_key: "master",
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
  notebookRepo?: Partial<NotebookRepository>;
  markdownRow?: MarkdownDigestRow | undefined;
  documents?: DocumentRow[];
  documentsForPartition?: Record<string, DocumentRow[]>;
  titleTemplate?: (d: string, p: string) => string;
  config?: NotebookServiceConfig;
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
    makeDoc({
      id: "doc-3",
      title: "Article Three",
      source_url: "https://example.com/three",
      canonical_url: "https://example.com/three",
    }),
    makeDoc({
      id: "doc-4",
      title: "Article Four",
      source_url: "https://example.com/four",
      canonical_url: "https://example.com/four",
    }),
    makeDoc({
      id: "doc-5",
      title: "Article Five",
      source_url: "https://example.com/five",
      canonical_url: "https://example.com/five",
    }),
    makeDoc({
      id: "doc-6",
      title: "Article Six",
      source_url: "https://example.com/six",
      canonical_url: "https://example.com/six",
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
    getByEditionAndPartition: vi
      .fn()
      .mockImplementation(
        async (_ed: string, partitionKey: string) => {
          if (overrides.documentsForPartition) {
            return (
              overrides.documentsForPartition[partitionKey] ??
              overrides.documentsForPartition["master"] ??
              []
            );
          }
          return partitionKey === "master" ? documents : [];
        },
      ),
    getRankedByEditionAndPartition: vi
      .fn()
      .mockImplementation(
        async (
          _ed: string,
          partitionKey: string,
          limit: number,
        ): Promise<{ kept: DocumentRow[]; excluded: DocumentRow[] }> => {
          let pool: DocumentRow[] = [];
          if (overrides.documentsForPartition) {
            pool =
              overrides.documentsForPartition[partitionKey] ??
              overrides.documentsForPartition["master"] ??
              [];
          } else if (partitionKey === "master") {
            pool = documents;
          }
          if (pool.length <= limit) {
            return { kept: pool, excluded: [] };
          }
          return {
            kept: pool.slice(0, limit),
            excluded: pool.slice(limit),
          };
        },
      ),
  };
  const notebookById = new Map<string, NotebookRow>();
  const notebookRepo: NotebookRepository = {
    getByEdition: vi
      .fn()
      .mockImplementation(async () => overrides.existingNotebookRow),
    getByEditionAndPartition: vi
      .fn()
      .mockImplementation(async () => overrides.existingNotebookRow),
    createForEdition: vi
      .fn()
      .mockImplementation(
        async (input: Parameters<NotebookRepository["createForEdition"]>[0]) => {
          const row = makeNotebookRow({
            id: "nb-row-1",
            edition_id: input.editionId,
            notebook_external_id: input.notebookExternalId,
            title: input.title,
            url: input.url,
            partition_key: input.partitionKey ?? "master",
            source_count: input.sourceCount ?? 0,
            status: input.status ?? "pending",
            provider_response: input.providerResponse ?? null,
          });
          notebookById.set(row.id, row);
          return row;
        },
      ),
    updateDelivery: vi
      .fn()
      .mockImplementation(
        async (
          id: string,
          update: Parameters<NotebookRepository["updateDelivery"]>[1],
        ) => {
          const previous = notebookById.get(id);
          const row = makeNotebookRow({
            id,
            status: update.status ?? "pending",
            source_count: update.sourceCount ?? 0,
            completed_at: update.completedAt ?? null,
            provider_response: update.providerResponse ?? null,
            partition_key: previous?.partition_key ?? "master",
          });
          notebookById.set(id, row);
          return row;
        },
      ),
    getById: vi.fn(),
    getByExternalId: vi.fn(),
    deleteByEdition: vi.fn(),
    deleteByEditionAndPartition: vi.fn(),
    ...overrides.notebookRepo,
  };
  const notebookLm =
    overrides.notebookLm ?? makeFakeNotebookLmClient();

  const config: NotebookServiceConfig | undefined = overrides.config
    ?? (overrides.titleTemplate
      ? { titleTemplate: overrides.titleTemplate }
      : undefined);

  const deps: NotebookServiceDeps = {
    db: {} as never,
    editionRepo: editionRepo as never,
    markdownDigestRepo: markdownDigestRepo as never,
    docRepo: docRepo as never,
    notebookRepo,
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
    expect(result.sourceCount).toBe(7);
    expect(result.notebookId).toBe("nb-row-1");
    expect(result.partitionKey).toBe("master");
    expect(result.skipReason).toBeNull();

    const order = (
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    expect(order).toBeGreaterThan(0);

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(7);
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
      url: "https://example.com/three",
      displayName: "Article Three",
    });
    expect(addSourceCalls[6]![0]).toMatchObject({
      notebookExternalId: "nb-ext-1",
      markdownContent: "# Daily Digest — 2026-07-07\n\nBody.\n",
      displayName: "Daily Digest 2026-07-07",
    });

    const waitCalls = (mocks.notebookLm.waitForSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(waitCalls).toHaveLength(7);

    const updateCalls = (mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    const readyCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    );
    expect(readyCall).toBeDefined();
    expect(readyCall![1]).toMatchObject({
      status: "ready",
      sourceCount: 7,
    });
  });

  it("passes the templated title (with default partition) to createNotebook when titleTemplate is configured", async () => {
    const { deps, mocks } = makeDeps({
      titleTemplate: (d, p) => `PNIP ${d} ${p}`,
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    const arg = (
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(arg.title).toBe("PNIP 2026-07-07 master");
  });

  it("threads the partition key into a custom titleTemplate", async () => {
    const ytDocs = Array.from({ length: 6 }, (_, i) =>
      makeDoc({
        id: `y-doc-${i}`,
        partition_key: "youtube",
        title: `YT ${i}`,
        source_url: `https://youtube.com/v/${i}`,
        canonical_url: `https://youtube.com/v/${i}`,
      }),
    );
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: [], youtube: ytDocs },
      titleTemplate: (d, p) => `Daily Digest — ${d} (${p})`,
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", partitionKey: "youtube" });
    const arg = (
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(arg.title).toBe("Daily Digest — 2026-07-07 (youtube)");
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
      config: { partitionMinArticles: 1 },
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
      config: { partitionMinArticles: 1 },
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
      config: { partitionMinArticles: 1 },
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
    expect(result.partitionKey).toBe("master");
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
    const { deps, mocks } = makeDeps({
      documents: [],
      config: { partitionMinArticles: 0 },
    });
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
      config: { partitionMinArticles: 0 },
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
      config: { partitionMinArticles: 1 },
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
    let getByEditionAndPartitionCalls = 0;
    const notebookRepo = {
      getByEdition: vi.fn().mockImplementation(async () => {
        return undefined;
      }),
      getByEditionAndPartition: vi.fn().mockImplementation(async () => {
        getByEditionAndPartitionCalls++;
        if (getByEditionAndPartitionCalls === 1) return undefined;
        return readyExisting;
      }),
      createForEdition: vi.fn().mockImplementation(async () => {
        throw new NotebookConflictError("ed-1", "master");
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
      deleteByEditionAndPartition: vi.fn(),
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
        throw new NotebookConflictError("ed-1", "master");
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
      mocks.notebookRepo.deleteByEditionAndPartition as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.notebookRepo.deleteByEditionAndPartition as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith("ed-1", "master");
  });
});

describe("generate — DB-row-first race serialization", () => {
  it("loser of the concurrent insert race does not call createNotebook or addSource", async () => {
    const winnerRow = makeNotebookRow({
      id: "nb-winner",
      status: "pending",
      notebook_external_id: "nb-ext-winner",
      url: "https://notebooklm.google.com/notebook/nb-ext-winner",
      provider_response: {
        phase: "pending",
        createNotebook: {
          notebookExternalId: "nb-ext-winner",
          title: "Daily Digest",
          url: "https://notebooklm.google.com/notebook/nb-ext-winner",
          createdAt: null,
        },
        uploadedSources: [
          { sourceExternalId: "src-w1", docId: null, displayName: "src w1" },
        ],
      },
    });
    let getByEditionAndPartitionCalls = 0;
    const { deps, mocks } = makeDeps({
      existingNotebookRow: undefined,
      notebookRepo: {
        getByEditionAndPartition: vi.fn().mockImplementation(async () => {
          getByEditionAndPartitionCalls++;
          if (getByEditionAndPartitionCalls === 1) return undefined;
          return winnerRow;
        }),
        createForEdition: vi.fn().mockImplementation(async () => {
          throw new NotebookConflictError("ed-1", "master");
        }),
      },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });

    expect(result.alreadyExisted).toBe(true);
    expect(result.notebookId).toBe("nb-winner");
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1);
  });

  it("createNotebook failure after DB insert leaves a row with status='failed' and placeholder external_id", async () => {
    const placeholderRow = makeNotebookRow({
      id: "nb-placeholder",
      status: "pending",
      notebook_external_id: "pending",
      url: "https://notebooklm.google.com/notebook/pending",
    });
    const notebookLm = makeFakeNotebookLmClient({
      createThrows: new NotebookLmError({
        message: "notebooklm create failed",
        command: "notebooklm create X --json",
        exitCode: 1,
        stderr: "create failed",
        stdout: null,
        durationMs: 10,
        timedOut: false,
      }),
    });
    let createCount = 0;
    const { deps, mocks } = makeDeps({
      notebookLm,
      notebookRepo: {
        getByEditionAndPartition: vi
          .fn()
          .mockImplementation(async () => placeholderRow),
        createForEdition: vi.fn().mockImplementation(async () => {
          createCount++;
          if (createCount === 1) return placeholderRow;
          throw new NotebookConflictError("ed-1", "master");
        }),
      },
    });
    const svc = createNotebookService(deps);
    await expect(
      svc.generate({ editionId: "ed-1", wait: true }),
    ).rejects.toThrow(/notebooklm create failed/);

    const createCalls = (
      mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]![0]).toMatchObject({
      editionId: "ed-1",
      partitionKey: "master",
      notebookExternalId: "pending",
      url: "https://notebooklm.google.com/notebook/pending",
      status: "pending",
      sourceCount: 0,
    });

    const updateCalls = (
      mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const failedUpdate = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "failed",
    );
    expect(failedUpdate).toBeDefined();

    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("addSource failure after NotebookLM creation leaves status='failed' and real external_id, with earlier uploads visible", async () => {
    const realRow = makeNotebookRow({
      id: "nb-real",
      status: "pending",
      notebook_external_id: "nb-ext-1",
      url: "https://notebooklm.google.com/notebook/nb-ext-1",
    });
    const notebookLm = makeFakeNotebookLmClient({
      addSourceOverride: (() => {
        let callIndex = 0;
        return (_input: unknown): AddSourceResult => {
          callIndex++;
          if (callIndex === 3) {
            throw new NotebookLmError({
              message: "add source failed on 3rd",
              command: "notebooklm source add X -n Y --json",
              exitCode: 1,
              stderr: "boom",
              stdout: null,
              durationMs: 10,
              timedOut: false,
            });
          }
          return {
            sourceExternalId: `src-${callIndex}`,
            title: null,
            kind: null,
            url: null,
            status: "processing",
          };
        };
      })(),
    });
    let getCalls = 0;
    let createCount = 0;
    const { deps, mocks } = makeDeps({
      notebookLm,
      notebookRepo: {
        getByEditionAndPartition: vi.fn().mockImplementation(async () => {
          getCalls++;
          if (getCalls === 1) return undefined;
          return realRow;
        }),
        createForEdition: vi.fn().mockImplementation(async () => {
          createCount++;
          if (createCount === 1) return realRow;
          throw new NotebookConflictError("ed-1", "master");
        }),
      },
    });
    const svc = createNotebookService(deps);
    await expect(
      svc.generate({ editionId: "ed-1", wait: true }),
    ).rejects.toThrow(/add source failed on 3rd/);

    const updateCalls = (
      mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const failedUpdate = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "failed",
    );
    expect(failedUpdate).toBeDefined();

    const addSourceCalls = (
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(addSourceCalls).toHaveLength(3);
    for (const call of addSourceCalls) {
      expect(call[0]).toMatchObject({
        notebookExternalId: "nb-ext-1",
      });
    }
  });

  it("recovers an existing pending row with placeholder external_id by deleting and retrying", async () => {
    const placeholderExisting = makeNotebookRow({
      id: "nb-placeholder-stale",
      status: "pending",
      notebook_external_id: "pending",
      url: "https://notebooklm.google.com/notebook/pending",
      provider_response: { phase: "pending" },
    });
    const freshRow = makeNotebookRow({
      id: "nb-fresh",
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
      existingNotebookRow: placeholderExisting,
      notebookLm,
    });
    (deps.notebookRepo.getByEditionAndPartition as ReturnType<typeof vi.fn>).mockImplementation(
      async () => placeholderExisting,
    );
    (deps.notebookRepo.createForEdition as ReturnType<typeof vi.fn>).mockResolvedValue(
      freshRow,
    );
    (deps.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        id: string,
        update: Parameters<NotebookRepository["updateDelivery"]>[1],
      ) =>
        makeNotebookRow({
          id,
          notebook_external_id: update.notebookExternalId ?? freshRow.notebook_external_id,
          title: update.title ?? freshRow.title,
          url: update.url ?? freshRow.url,
          status: update.status ?? "pending",
          source_count: update.sourceCount ?? 0,
          completed_at: update.completedAt ?? null,
          provider_response: update.providerResponse ?? null,
        }),
    );
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });

    expect(
      mocks.notebookRepo.deleteByEditionAndPartition as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith("ed-1", "master");
    expect(result.notebookId).toBe("nb-fresh");
    expect(result.notebookExternalId).toBe("nb-ext-fresh");
    expect(result.alreadyExisted).toBe(false);
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
  });

  it("reuses an existing pending row that has a real external_id and uploadedSources", async () => {
    const realExisting = makeNotebookRow({
      id: "nb-real-existing",
      status: "pending",
      notebook_external_id: "nb-ext-real",
      url: "https://notebooklm.google.com/notebook/nb-ext-real",
      source_count: 2,
      provider_response: {
        phase: "pending",
        createNotebook: {
          notebookExternalId: "nb-ext-real",
          title: "Daily Digest",
          url: "https://notebooklm.google.com/notebook/nb-ext-real",
          createdAt: null,
        },
        uploadedSources: [
          { sourceExternalId: "src-1", docId: null, displayName: "src 1" },
          { sourceExternalId: "src-2", docId: null, displayName: "src 2" },
        ],
      },
    });
    const { deps, mocks } = makeDeps({ existingNotebookRow: realExisting });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1" });

    expect(result.alreadyExisted).toBe(true);
    expect(result.notebookId).toBe("nb-real-existing");
    expect(result.notebookExternalId).toBe("nb-ext-real");
    expect(result.sourceCount).toBe(2);
    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("race-loser with wait=true does not mark a placeholder/empty-source row as ready", async () => {
    const emptySourcesRow = makeNotebookRow({
      id: "nb-empty-sources",
      status: "pending",
      notebook_external_id: "nb-ext-real",
      url: "https://notebooklm.google.com/notebook/nb-ext-real",
      source_count: 0,
      provider_response: {
        phase: "pending",
        createNotebook: {
          notebookExternalId: "nb-ext-real",
          title: "Daily Digest",
          url: "https://notebooklm.google.com/notebook/nb-ext-real",
          createdAt: null,
        },
        uploadedSources: [],
      },
    });
    const { deps, mocks } = makeDeps({ existingNotebookRow: emptySourcesRow });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(
      mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      mocks.notebookLm.addSource as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    const updateCalls = (
      mocks.notebookRepo.updateDelivery as ReturnType<typeof vi.fn>
    ).mock.calls;
    const readyCall = updateCalls.find(
      ([, u]) => (u as { status?: string }).status === "ready",
    );
    expect(readyCall).toBeUndefined();

    expect(result.status).toBe("pending");
    expect(result.sourceCount).toBe(0);
    expect(result.notebookId).toBe("nb-empty-sources");
    expect(result.notebookExternalId).toBe("nb-ext-real");
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
      ([, u]) => {
        const pr = (u as { providerResponse?: { phase?: string; uploadedSources?: unknown[] } }).providerResponse;
        return (
          pr?.phase === "pending" &&
          Array.isArray(pr.uploadedSources) &&
          pr.uploadedSources.length > 0
        );
      },
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

  it("forwards partitionKey to the service", async () => {
    const { deps, mocks } = makeDeps();
    const svc = createNotebookService(deps);
    await svc.generateForDate({
      editionDate: "2026-07-07",
      partitionKey: "youtube",
      wait: true,
    });
    expect(
      (
        mocks.notebookRepo.getByEditionAndPartition as ReturnType<typeof vi.fn>
      ).mock.calls[0]!,
    ).toEqual(["ed-1", "youtube"]);
    expect(
      (mocks.docRepo.getByEditionAndPartition as ReturnType<typeof vi.fn>)
        .mock.calls[0]!,
    ).toEqual(["ed-1", "youtube"]);
  });
});

describe("generate — partition awareness", () => {
  it("uses getByEditionAndPartition with the supplied partition key", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: {
        youtube: [],
      },
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", partitionKey: "youtube" });
    expect(
      (
        mocks.notebookRepo.getByEditionAndPartition as ReturnType<typeof vi.fn>
      ).mock.calls[0]!,
    ).toEqual(["ed-1", "youtube"]);
  });

  it("passes the partition key into createForEdition", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: {
        youtube: Array.from({ length: 8 }, (_, i) =>
          makeDoc({
            id: `y-doc-${i}`,
            title: `YT ${i}`,
            partition_key: "youtube",
            source_url: `https://youtube.com/v/${i}`,
            canonical_url: `https://youtube.com/v/${i}`,
          }),
        ),
      },
    });
    const svc = createNotebookService(deps);
    await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
      wait: true,
    });
    const createCalls = (
      mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![0]).toMatchObject({
      editionId: "ed-1",
      partitionKey: "youtube",
    });
    expect(
      (mocks.docRepo.getByEditionAndPartition as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("ed-1", "youtube");
  });

  it("returns skipped when partition has fewer than minArticles documents", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: {
        youtube: [
          makeDoc({
            id: "y-doc-1",
            partition_key: "youtube",
            title: "YT 1",
            source_url: "https://youtube.com/v/1",
            canonical_url: "https://youtube.com/v/1",
          }),
          makeDoc({
            id: "y-doc-2",
            partition_key: "youtube",
            title: "YT 2",
            source_url: "https://youtube.com/v/2",
            canonical_url: "https://youtube.com/v/2",
          }),
          makeDoc({
            id: "y-doc-3",
            partition_key: "youtube",
            title: "YT 3",
            source_url: "https://youtube.com/v/3",
            canonical_url: "https://youtube.com/v/3",
          }),
        ],
      },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
    });
    expect(result.status).toBe("skipped");
    expect(result.alreadyExisted).toBe(false);
    expect(result.partitionKey).toBe("youtube");
    expect(result.skipReason).toMatch(/below threshold 5/);
    expect(result.skipReason).toMatch(/partition 'youtube'/);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(
      (mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("returns skipped when partition has 0 documents", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: { youtube: [], master: [] },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
    });
    expect(result.status).toBe("skipped");
    expect(result.sourceCount).toBe(0);
    expect(result.skipReason).toMatch(/0 uploadable documents/);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("honours a custom partitionMinArticles threshold from config", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: {
        youtube: [
          makeDoc({
            id: "y-doc-1",
            partition_key: "youtube",
            source_url: "https://youtube.com/v/1",
            canonical_url: "https://youtube.com/v/1",
          }),
          makeDoc({
            id: "y-doc-2",
            partition_key: "youtube",
            source_url: "https://youtube.com/v/2",
            canonical_url: "https://youtube.com/v/2",
          }),
        ],
      },
      config: { partitionMinArticles: 2 },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
      wait: true,
    });
    expect(result.status).toBe("ready");
    expect(result.partitionKey).toBe("youtube");
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });

  it("active: partition has at least minArticles documents, the notebook is created and uploaded", async () => {
    const ytDocs = Array.from({ length: 10 }, (_, i) =>
      makeDoc({
        id: `y-doc-${i}`,
        partition_key: "youtube",
        title: `YT ${i}`,
        source_url: `https://youtube.com/v/${i}`,
        canonical_url: `https://youtube.com/v/${i}`,
      }),
    );
    const { deps, mocks } = makeDeps({
      documentsForPartition: { youtube: ytDocs, master: [] },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
      wait: true,
    });
    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(false);
    expect(result.partitionKey).toBe("youtube");
    expect(result.sourceCount).toBe(ytDocs.length + 1);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    const createCalls = (
      mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![0]).toMatchObject({ partitionKey: "youtube" });
  });

  it("idempotent: existing notebook in the partition is reused", async () => {
    const existing = makeNotebookRow({
      id: "nb-youtube-existing",
      status: "ready",
      partition_key: "youtube",
      notebook_external_id: "nb-ext-youtube",
      url: "https://notebooklm.google.com/notebook/nb-ext-youtube",
      source_count: 12,
      completed_at: new Date(),
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: existing,
      documentsForPartition: {
        youtube: Array.from({ length: 10 }, (_, i) =>
          makeDoc({
            id: `y-doc-${i}`,
            partition_key: "youtube",
            source_url: `https://youtube.com/v/${i}`,
            canonical_url: `https://youtube.com/v/${i}`,
          }),
        ),
        master: [],
      },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
      wait: true,
    });
    expect(result.status).toBe("ready");
    expect(result.alreadyExisted).toBe(true);
    expect(result.notebookId).toBe("nb-youtube-existing");
    expect(result.partitionKey).toBe("youtube");
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("failed-retry only deletes the targeted partition's notebook", async () => {
    const failedMaster = makeNotebookRow({
      id: "nb-master-failed",
      status: "failed",
      partition_key: "master",
      notebook_external_id: "nb-ext-master-failed",
    });
    const ytDocs = Array.from({ length: 8 }, (_, i) =>
      makeDoc({
        id: `y-doc-${i}`,
        partition_key: "youtube",
        title: `YT ${i}`,
        source_url: `https://youtube.com/v/${i}`,
        canonical_url: `https://youtube.com/v/${i}`,
      }),
    );
    const { deps, mocks } = makeDeps({
      documentsForPartition: { youtube: ytDocs, master: [] },
      notebookRepo: {
        getByEditionAndPartition: vi
          .fn()
          .mockImplementation(
            async (_ed: string, partitionKey: string) =>
              partitionKey === "master" ? failedMaster : undefined,
          ),
        getByEdition: vi
          .fn()
          .mockImplementation(async () => failedMaster),
      },
    });
    const svc = createNotebookService(deps);
    await svc.generate({
      editionId: "ed-1",
      partitionKey: "youtube",
      wait: true,
    });
    const deleteCalls = (
      mocks.notebookRepo.deleteByEditionAndPartition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(deleteCalls).toHaveLength(0);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    const createCalls = (
      mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls[0]![0]).toMatchObject({ partitionKey: "youtube" });
  });

  it("failed-retry of the master partition deletes the master notebook (default behaviour)", async () => {
    const failedMaster = makeNotebookRow({
      id: "nb-master-failed",
      status: "failed",
      partition_key: "master",
      notebook_external_id: "nb-ext-master-failed",
    });
    const { deps, mocks } = makeDeps({
      existingNotebookRow: failedMaster,
    });
    const svc = createNotebookService(deps);
    await svc.generate({ editionId: "ed-1", wait: true });
    expect(
      (
        mocks.notebookRepo
          .deleteByEditionAndPartition as ReturnType<typeof vi.fn>
      ).mock.calls[0]!,
    ).toEqual(["ed-1", "master"]);
  });

  it("master partition is not subject to min_articles threshold", async () => {
    const { deps, mocks } = makeDeps({
      documentsForPartition: {
        master: [
          makeDoc({
            id: "m-doc-1",
            partition_key: "master",
            title: "Solo",
            source_url: "https://example.com/solo",
            canonical_url: "https://example.com/solo",
          }),
        ],
      },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({
      editionId: "ed-1",
      partitionKey: "master",
    });
    expect(result.status).toBe("pending");
    expect(result.partitionKey).toBe("master");
    expect(result.skipReason).toBeNull();
    expect(result.sourceCount).toBe(2);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
    expect(
      (mocks.notebookRepo.createForEdition as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });
});

describe("generate — 50-source cap and notebook_excluded signals", () => {
  function makeManyDocs(n: number, prefix = "d"): DocumentRow[] {
    return Array.from({ length: n }, (_, i) =>
      makeDoc({
        id: `${prefix}-${i}`,
        title: `Doc ${i}`,
        source_url: `https://example.com/${prefix}/${i}`,
        canonical_url: `https://example.com/${prefix}/${i}`,
      }),
    );
  }

  function makeFakeSignalRepo(): {
    createBatch: ReturnType<typeof vi.fn>;
  } {
    return {
      createBatch: vi.fn().mockResolvedValue([]),
    };
  }

  it("uploads only the cap (50) and writes notebook_excluded signals for the overflow", async () => {
    const docs = makeManyDocs(60);
    const signalRepo = makeFakeSignalRepo();
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: docs },
    });
    deps.signalRepo = signalRepo as never;
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(51);

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(51);

    expect(signalRepo.createBatch).toHaveBeenCalledTimes(1);
    const rows = signalRepo.createBatch.mock.calls[0]![0] as Array<{
      signal_kind: string;
      edition_id: string;
      document_id: string;
      source_url: string;
      payload: {
        partition_key: string;
        reason: string;
        cap: number;
        total_documents: number;
        rank: number;
      };
    }>;
    expect(rows).toHaveLength(10);
    expect(rows[0]!.signal_kind).toBe("notebook_excluded");
    expect(rows[0]!.edition_id).toBe("ed-1");
    expect(rows[0]!.document_id).toBe("d-50");
    expect(rows[0]!.payload.partition_key).toBe("master");
    expect(rows[0]!.payload.reason).toBe("source_cap");
    expect(rows[0]!.payload.cap).toBe(50);
    expect(rows[0]!.payload.total_documents).toBe(60);
    expect(rows[0]!.payload.rank).toBe(51);
    expect(rows[9]!.document_id).toBe("d-59");
    expect(rows[9]!.payload.rank).toBe(60);
  });

  it("writes no signals when there is no overflow", async () => {
    const docs = makeManyDocs(30);
    const signalRepo = makeFakeSignalRepo();
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: docs },
    });
    deps.signalRepo = signalRepo as never;
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(31);
    expect(signalRepo.createBatch).not.toHaveBeenCalled();

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(31);
  });

  it("honours a custom maxSourcesPerNotebook cap from config", async () => {
    const docs = makeManyDocs(20);
    const signalRepo = makeFakeSignalRepo();
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: docs },
      config: { maxSourcesPerNotebook: 10, partitionMinArticles: 1 },
    });
    deps.signalRepo = signalRepo as never;
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(11);

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(11);

    expect(signalRepo.createBatch).toHaveBeenCalledTimes(1);
    const rows = signalRepo.createBatch.mock.calls[0]![0] as Array<{
      payload: { cap: number; total_documents: number; rank: number };
    }>;
    expect(rows).toHaveLength(10);
    expect(rows[0]!.payload.cap).toBe(10);
    expect(rows[0]!.payload.total_documents).toBe(20);
    expect(rows[0]!.payload.rank).toBe(11);
    expect(rows[9]!.payload.rank).toBe(20);
  });

  it("does not crash and writes no signals when signalRepo is undefined", async () => {
    const docs = makeManyDocs(60);
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: docs },
    });
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(51);

    const addSourceCalls = (mocks.notebookLm.addSource as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(addSourceCalls).toHaveLength(51);
  });

  it("skips the signal write but still creates the notebook when the signal write fails", async () => {
    const docs = makeManyDocs(60);
    const signalRepo = makeFakeSignalRepo();
    signalRepo.createBatch.mockRejectedValue(new Error("signals table missing"));
    const { deps, mocks } = makeDeps({
      documentsForPartition: { master: docs },
    });
    deps.signalRepo = signalRepo as never;
    const svc = createNotebookService(deps);
    const result = await svc.generate({ editionId: "ed-1", wait: true });

    expect(result.status).toBe("ready");
    expect(result.sourceCount).toBe(51);
    expect(signalRepo.createBatch).toHaveBeenCalledTimes(1);
    expect(
      (mocks.notebookLm.createNotebook as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledOnce();
  });
});