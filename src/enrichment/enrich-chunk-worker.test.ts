import { describe, expect, it, vi } from "vitest";
import { createEnrichChunkWorker } from "./enrich-chunk-worker.js";
import type { ProcessingJob } from "../database/kysely.js";

const job: ProcessingJob = {
  id: "job", job_type: "enrich_chunk", edition_id: "edition", target: { chunkId: "chunk", documentId: "doc" },
  status: "running", retry_count: 0, last_error: null, last_attempt_at: null, next_eligible_at: new Date(), locked_by: null,
  locked_at: null, created_at: new Date(), updated_at: new Date(), completed_at: null, depends_on: [],
};

const metadata = { promptId: "prompt", promptVersion: 1, model: "model", provider: "provider", inputHash: "hash" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as any;

describe("EnrichChunkWorker", () => {
  it("uses one structured model call and persists all existing enrichment artifacts", async () => {
    const promptExecutor = { execute: vi.fn().mockResolvedValue({ ...metadata, content: JSON.stringify({
      summary: "A grounded summary.", claims: ["A grounded claim."],
      entities: [{ name: "Acme", type: "organization", mention: "Acme" }],
      topics: [{ topic: "test topic", confidence: 0.9, relevance: 0.8 }],
      quality: { label: "high", confidence: 0.7, reasoning: "Well sourced." },
    }) }) };
    const summaryRepo = { replaceForChunk: vi.fn().mockResolvedValue({ summary: { id: "summary" }, citations: [{ chunk_id: "chunk" }] }) };
    const entityRepo = { replaceForChunk: vi.fn().mockResolvedValue({ entities: [{ id: "entity" }], mentions: [{ entity_id: "entity", chunk_id: "chunk" }] }) };
    const topicRepo = { replaceForChunk: vi.fn().mockResolvedValue({ topics: [{ id: "topic" }], assignments: [{ topic_id: "topic", chunk_id: "chunk" }] }) };
    const qualityRepo = { replaceForChunk: vi.fn().mockResolvedValue({ id: "quality" }) };
    const gate = { markEnrichmentDoneAndMaybeEnqueueCluster: vi.fn().mockResolvedValue(null) };
    const provenanceRepo = { recordLineage: vi.fn().mockResolvedValue(undefined) };
    const worker = createEnrichChunkWorker({
      chunkRepo: { getByDocumentIdOrdered: vi.fn().mockResolvedValue([{ id: "chunk", content_text: "source text" }]) } as any,
      summaryRepo: summaryRepo as any, entityRepo: entityRepo as any, topicRepo: topicRepo as any, qualityRepo: qualityRepo as any,
      promptRepo: { getLatestVersion: vi.fn().mockResolvedValue({ id: "prompt", version: 1 }) } as any,
      promptExecutor: promptExecutor as any, provider: {} as any,
      provenanceRepo: provenanceRepo as any,
      gate: gate as any, editionRepo: { isProcessingAllowed: vi.fn().mockResolvedValue(true) } as any,
    });

    const outcome = await worker.execute(job, { db: {} as any, logger });

    expect(promptExecutor.execute).toHaveBeenCalledTimes(1);
    expect(summaryRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: "chunk", claims: [{ text: "A grounded claim.", chunkId: "chunk" }] }));
    expect(entityRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ entities: [{ name: "Acme", entityType: "organization", mentionText: "Acme" }] }));
    expect(topicRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ topics: [{ topic: "test topic", confidence: 0.9, relevance: 0.8 }] }));
    expect(qualityRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ label: "high" }));
    expect(gate.markEnrichmentDoneAndMaybeEnqueueCluster).toHaveBeenCalledWith("edition", "doc", "enrich_chunk", "chunk");
    expect(provenanceRepo.recordLineage).toHaveBeenCalledWith(expect.objectContaining({ relation: "mentioned_in", sourceId: "entity", targetId: "chunk" }));
    expect(provenanceRepo.recordLineage).toHaveBeenCalledWith(expect.objectContaining({ relation: "covers", sourceId: "topic", targetId: "chunk" }));
    expect(outcome.childJobs).toEqual([
      { jobType: "embed_chunk", editionId: "edition", target: { chunkId: "chunk", documentId: "doc" } },
    ]);
  });

  it("uses grounded/empty fallbacks for malformed structured output", async () => {
    const summaryRepo = { replaceForChunk: vi.fn().mockResolvedValue({ summary: { id: "s" }, citations: [] }) };
    const entityRepo = { replaceForChunk: vi.fn().mockResolvedValue({ entities: [], mentions: [] }) };
    const topicRepo = { replaceForChunk: vi.fn().mockResolvedValue({ topics: [], assignments: [] }) };
    const qualityRepo = { replaceForChunk: vi.fn().mockResolvedValue({ id: "q" }) };
    const worker = createEnrichChunkWorker({
      chunkRepo: { getByDocumentIdOrdered: vi.fn().mockResolvedValue([{ id: "chunk", content_text: "source text" }]) } as any,
      summaryRepo: summaryRepo as any, entityRepo: entityRepo as any, topicRepo: topicRepo as any, qualityRepo: qualityRepo as any,
      promptRepo: { getLatestVersion: vi.fn().mockResolvedValue({ id: "prompt", version: 1 }) } as any,
      promptExecutor: { execute: vi.fn().mockResolvedValue({ ...metadata, content: "not json" }) } as any, provider: {} as any,
      provenanceRepo: { recordLineage: vi.fn().mockResolvedValue(undefined) } as any,
      gate: { markEnrichmentDoneAndMaybeEnqueueCluster: vi.fn().mockResolvedValue(null) } as any,
      editionRepo: { isProcessingAllowed: vi.fn().mockResolvedValue(true) } as any,
    });
    await worker.execute(job, { db: {} as any, logger });
    expect(summaryRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ content: "source text", claims: [{ text: "source text", chunkId: "chunk" }] }));
    expect(entityRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ entities: [] }));
    expect(topicRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ topics: [] }));
    expect(qualityRepo.replaceForChunk).toHaveBeenCalledWith(expect.objectContaining({ label: "medium", confidence: 0 }));
  });

  it("does not invoke AI when the edition is immutable or the target chunk is absent", async () => {
    const execute = vi.fn();
    const common = {
      summaryRepo: {} as any, entityRepo: {} as any, topicRepo: {} as any, qualityRepo: {} as any,
      promptRepo: { getLatestVersion: vi.fn() } as any, promptExecutor: { execute } as any, provider: {} as any,
      provenanceRepo: {} as any, gate: {} as any,
    };
    const immutable = createEnrichChunkWorker({ ...common, chunkRepo: {} as any, editionRepo: { isProcessingAllowed: vi.fn().mockResolvedValue(false) } as any });
    await immutable.execute(job, { db: {} as any, logger });
    const missing = createEnrichChunkWorker({ ...common, chunkRepo: { getByDocumentIdOrdered: vi.fn().mockResolvedValue([]) } as any, editionRepo: { isProcessingAllowed: vi.fn().mockResolvedValue(true) } as any });
    await missing.execute(job, { db: {} as any, logger });
    expect(execute).not.toHaveBeenCalled();
  });
});
