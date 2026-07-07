import { describe, it, expect, vi } from "vitest";
import { createExpandDocumentWorker } from "./expand-document-worker.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";
import type { DocumentRepository } from "./document-repository.js";
import type { SectionRepository } from "./section-repository.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type { ExpansionPlugin } from "./types.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";

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

function fakeQueue(): ProcessingJobQueue {
  return {
    enqueue: vi.fn().mockResolvedValue({ id: "refresh-job-1" }),
    claim: vi.fn(),
    complete: vi.fn(),
    getJob: vi.fn(),
    recoverStaleJobs: vi.fn(),
    archiveJobs: vi.fn(),
    purgeArchivedJobs: vi.fn(),
    countByStatus: vi.fn(),
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
      queue: fakeQueue(),
    });
    expect(worker.supports("expand_document")).toBe(true);
    expect(worker.supports("other")).toBe(false);
  });

  it("expands document via matching plugin and persists it", async () => {
    const plugin = fakePlugin("article", true);
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn().mockResolvedValue({ id: "doc-1", edition_id: "edition-1", source_url: "https://example.com/article" }),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
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

    const queue = fakeQueue();

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
      queue,
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(pluginRegistry.select).toHaveBeenCalledWith("https://example.com/article");
    expect(plugin.expand).toHaveBeenCalled();
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
    expect(queue.enqueue).not.toHaveBeenCalled();
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
    };

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue({ id: "existing-doc" }),
    };

    const sectionRepo: SectionRepository = {
      createBatch: vi.fn(),
      getByDocumentId: vi.fn(),
      getMaxOrder: vi.fn(),
      getByDocumentIdAndType: vi.fn(),
    };

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo: {} as ProvenanceRepository,
      queue: fakeQueue(),
    });

    const outcome = await worker.execute(makeJob(), {
      db: {} as any,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    });

    expect(docRepo.create).not.toHaveBeenCalled();
    expect(sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(outcome).toEqual({});
  });

  it("throws when no plugin matches the URL", async () => {
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => undefined),
    };

    const worker = createExpandDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      pluginRegistry,
      provenanceRepo: {} as ProvenanceRepository,
      queue: fakeQueue(),
    });

    await expect(worker.execute(makeJob(), { db: {} as any, logger: {} as any })).rejects.toThrow(
      /no plugin supports/i,
    );
  });

  it("throws when target is missing", async () => {
    const worker = createExpandDocumentWorker({
      docRepo: {} as DocumentRepository,
      sectionRepo: {} as SectionRepository,
      pluginRegistry: { register: vi.fn(), select: vi.fn() },
      provenanceRepo: {} as ProvenanceRepository,
      queue: fakeQueue(),
    });

    await expect(
      worker.execute(makeJob({ target: null }), { db: {} as any, logger: {} as any }),
    ).rejects.toThrow(/invalid target/i);
  });

  it("on RedditRateLimitError re-enqueues expand_document with delayed nextEligibleAt and returns {}", async () => {
    const plugin: ExpansionPlugin = {
      name: "reddit",
      supports: () => true,
      expand: vi.fn().mockRejectedValue(new RedditRateLimitError(45)),
    };
    const pluginRegistry: PluginRegistry = {
      register: vi.fn(),
      select: vi.fn(() => plugin),
    };

    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
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
    const queue = fakeQueue();

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
      queue,
    });

    const redditUrl = "https://www.reddit.com/r/test/comments/1upftp9/title/";
    const before = Date.now();
    const outcome = await worker.execute(
      makeJob({ target: { discoveryEventId: "event-1", url: redditUrl } }),
      { db: {} as any, logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any },
    );

    expect(docRepo.create).not.toHaveBeenCalled();
    expect(sectionRepo.createBatch).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const arg = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.jobType).toBe("expand_document");
    expect(arg.editionId).toBe("edition-1");
    expect(arg.target).toEqual({ discoveryEventId: "event-1", url: redditUrl });
    const elapsed = arg.nextEligibleAt.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(45 * 1000 - 1000);
    expect(elapsed).toBeLessThanOrEqual(45 * 1000 + 5000);
    expect(outcome).toEqual({});
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
    };
    const docRepo: DocumentRepository = {
      create: vi.fn(),
      getById: vi.fn(),
      getByEdition: vi.fn(),
      getByEditionAndUrl: vi.fn().mockResolvedValue(undefined),
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
    const queue = fakeQueue();

    const worker = createExpandDocumentWorker({
      docRepo,
      sectionRepo,
      pluginRegistry,
      provenanceRepo,
      queue,
    });

    await expect(
      worker.execute(
        makeJob({ target: { discoveryEventId: "event-1", url: "https://www.reddit.com/r/test/comments/1upftp9/title/" } }),
        { db: {} as any, logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() } as any },
      ),
    ).rejects.toThrow(/boom/);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
