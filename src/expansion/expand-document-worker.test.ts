import { describe, it, expect, vi } from "vitest";
import { createExpandDocumentWorker } from "./expand-document-worker.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";
import type { DocumentRepository } from "./document-repository.js";
import type { SectionRepository } from "./section-repository.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type { ExpansionPlugin } from "./types.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";

function fakePlugin(name: string, supports: boolean, sourceType = "article"): ExpansionPlugin {
  return {
    name,
    supports: () => supports,
    expand: vi.fn().mockResolvedValue({
      title: "Test Article",
      content: "# Test\n\nBody.",
      plainText: "Test Body.",
      sourceType,
      sections: [
        { order: 0, section_type: "title", content_markdown: "# Test", content_text: "Test" },
        { order: 1, section_type: "paragraph", content_markdown: "Body.", content_text: "Body." },
      ],
    }),
  };
}

function makeJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    job_type: "expand_document",
    edition_id: "edition-1",
    target: { discoveryEventId: "event-1", url: "https://example.com/article" },
    status: "running",
    retry_count: 0,
    last_error: null,
    last_attempt_at: null,
    next_eligible_at: new Date(),
    locked_by: "worker-1",
    locked_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    depends_on: [],
    ...overrides,
  };
}

describe("ExpandDocumentWorker", () => {
  it("supports expand_document job type", () => {
    const worker = createExpandDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      pluginRegistry: {} as PluginRegistry,
      provenanceRepo: {} as ProvenanceRepository,
    });
    expect(worker.supports("expand_document")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("expands document via matching plugin and persists it", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1", source_url: "https://example.com/article", partition_key: "master" }),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };

    const sectionRepo: SectionRepository = {
      createBatch: vi.fn().mockResolvedValue([]),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };

    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn().mockResolvedValue(undefined),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    const outcome = await worker.execute(makeJob({
      target: {
        discoveryEventId: "event-1",
        url: "https://example.com/article",
        title: "Feed-provided title",
      },
    }), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(pluginRegistry.select).toHaveBeenCalledWith("https://example.com/article");
    expect(plugin.expand).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Feed-provided title" }),
    );
    expect(docRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        editionId: "edition-1",
        sourceUrl: "https://example.com/article",
        sourceType: "article",
        title: "Test Article",
        contentMarkdown: "# Test\n\nBody.",
      }),
    );
    expect(sectionRepo.createBatch).toHaveBeenCalled();
    expect(provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "discovery_event",
        sourceId: "event-1",
        targetType: "document",
        targetId: "doc-1",
        relation: "expanded_from",
      }),
    );
    expect(outcome).toEqual({
      childJobs: [
        {
          jobType: "chunk_document",
          editionId: "edition-1",
          target: { documentId: "doc-1" },
        },
      ],
    });
  });

  it("skips expansion when document already exists (idempotency)", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue({ id: "existing-doc" }),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };

    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([{} as any]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo: {} as ProvenanceRepository,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(docRepo.create).not.toHaveBeenCalled();
    expect(sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("repairs an existing document with no sections and emits the chunk job", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue({
        id: "partial-doc",
        edition_id: "edition-1",
      }),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn().mockResolvedValue([]),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn().mockResolvedValue(undefined),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(plugin.expand).toHaveBeenCalledTimes(1);
    expect(sectionRepo.createBatch).toHaveBeenCalledWith([
      expect.objectContaining({ documentId: "partial-doc", order: 0 }),
      expect.objectContaining({ documentId: "partial-doc", order: 1 }),
    ]);
    expect(provenanceRepo.recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "partial-doc" }),
    );
    expect(outcome).toEqual({
      childJobs: [
        {
          jobType: "chunk_document",
          editionId: "edition-1",
          target: { documentId: "partial-doc" },
        },
      ],
    });
  });

  it("throws when no plugin matches the URL", async () => {
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => undefined),
      list: vi.fn(() => []),
    };

    const worker = createExpandDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      pluginRegistry,
      provenanceRepo: {} as ProvenanceRepository,
    });

    await expect(worker.execute(makeJob(), { db: {} as any, logger: {} as any })).rejects.toThrow(
      /no plugin supports/i,
    );
  });

  it("throws when target is missing", async () => {
    const worker = createExpandDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      pluginRegistry: { register: vi.fn(), select: vi.fn(), list: vi.fn(() => []) },
      provenanceRepo: {} as ProvenanceRepository,
    });

    await expect(
      worker.execute(makeJob({ target: null }), { db: {} as any, logger: {} as any }),
    ).rejects.toThrow(/invalid target/i);
  });

  it("on RedditRateLimitError defers the existing job until resetSeconds (does not duplicate)", async () => {
    const plugin: ExpansionPlugin = {
      name: "reddit",
      supports: () => true,
      expand: vi.fn().mockRejectedValue(new RedditRateLimitError(45)),
    };
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    const redditUrl = "https://www.reddit.com/r/test/comments/1upftp9/title/";
    const before = Date.now();
    const outcome = await worker.execute(
      makeJob({ target: { discoveryEventId: "event-1", url: redditUrl } }),
      { db: {} as any, logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any },
    );

    expect(docRepo.create).not.toHaveBeenCalled();
    expect(sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(provenanceRepo.recordLineage).not.toHaveBeenCalled();
    expect(outcome.childJobs).toBeUndefined();
    expect(outcome.deferUntil).toBeInstanceOf(Date);
    const elapsed = outcome.deferUntil!.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(45 * 1000 - 1000);
    expect(elapsed).toBeLessThanOrEqual(45 * 1000 + 5000);
  });

  it("on RedditRateLimitError during repair, defers without emitting a chunk job", async () => {
    const plugin: ExpansionPlugin = {
      name: "reddit",
      supports: () => true,
      expand: vi.fn().mockRejectedValue(new RedditRateLimitError(30)),
    };
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue({
        id: "partial-doc",
        edition_id: "edition-1",
      }),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn().mockResolvedValue([]),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    const redditUrl = "https://www.reddit.com/r/test/comments/1upftp9/title/";
    const before = Date.now();
    const outcome = await worker.execute(
      makeJob({ target: { discoveryEventId: "event-1", url: redditUrl } }),
      { db: {} as any, logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any },
    );

    expect(sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(provenanceRepo.recordLineage).not.toHaveBeenCalled();
    expect(outcome.childJobs).toBeUndefined();
    expect(outcome.deferUntil).toBeInstanceOf(Date);
    const elapsed = outcome.deferUntil!.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(30 * 1000 - 1000);
    expect(elapsed).toBeLessThanOrEqual(30 * 1000 + 5000);
  });

  it("propagates non-rate-limit errors from plugin.expand", async () => {
    const plugin: ExpansionPlugin = {
      name: "reddit",
      supports: () => true,
      expand: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    await expect(
      worker.execute(
        makeJob({ target: { discoveryEventId: "event-1", url: "https://www.reddit.com/r/test/comments/1upftp9/title/" } }),
        { db: {} as any, logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any },
      ),
    ).rejects.toThrow(/boom/);
  });

  it("partitionKey: target with partitionKey='youtube' is forwarded to docRepo.create", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };
    const docRepo: DocumentRepository = {
      create: vi.fn().mockResolvedValue({
        id: "doc-1",
        edition_id: "edition-1",
        source_url: "https://example.com/youtube",
        partition_key: "youtube",
      }),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    await worker.execute(
      makeJob({
        target: {
          discoveryEventId: "event-1",
          url: "https://example.com/youtube",
          partitionKey: "youtube",
        },
      }),
      {
        db: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
      },
    );

    expect(docRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ partitionKey: "youtube" }),
    );
  });

  it("partitionKey: target without partitionKey defaults to 'master' in the created document", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
      list: vi.fn(() => []),
    };
    const docRepo: DocumentRepository = {
      create: vi.fn().mockResolvedValue({
        id: "doc-1",
        edition_id: "edition-1",
        source_url: "https://example.com/article",
        partition_key: "master",
      }),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
      getByEditionAndPartition: vi.fn(),
      getRankedByEditionAndPartition: vi.fn(),
    };
    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };
    const provenanceRepo: ProvenanceRepository = {
      recordLineage: vi.fn(),
      recordLineageBatch: vi.fn(),
      getSources: vi.fn(),
      getConsumers: vi.fn(),
      resolveCitations: vi.fn(),
      resolveToDocuments: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
    });

    await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(docRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ partitionKey: undefined }),
    );
  });
});
