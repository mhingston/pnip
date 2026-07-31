import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { ChunkRepository, DocumentChunkRow } from "../chunking/chunk-repository.js";
import type { PromptRepository } from "../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../ai/prompt-execution.js";
import type { AiProvider } from "../ai/provider.js";
import type { SummaryRepository } from "./summary/summary-repository.js";
import type { EntityRepository } from "./entities/entity-repository.js";
import type { TopicRepository } from "./topics/topic-repository.js";
import type { QualityRepository } from "./quality/quality-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { EnrichmentGateService } from "../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import { extractJson } from "../common/json-extract.js";

const PROMPT_NAME = "enrichment";

export interface EnrichChunkDeps {
  chunkRepo: ChunkRepository; summaryRepo: SummaryRepository; entityRepo: EntityRepository;
  topicRepo: TopicRepository; qualityRepo: QualityRepository; promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService; provider: AiProvider; provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService; editionRepo: EditionRepository; model?: string;
}

interface Target { chunkId: string; documentId: string }
function parseTarget(target: unknown): Target {
  if (!target || typeof target !== "object") throw new Error("invalid target: expected chunkId and documentId");
  const value = target as Record<string, unknown>;
  if (typeof value.chunkId !== "string" || typeof value.documentId !== "string") throw new Error("invalid target: missing chunkId or documentId");
  return { chunkId: value.chunkId, documentId: value.documentId };
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function unit(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined; }
function clip(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 1200); }

/** One text-model invocation which writes the existing four enrichment artifacts. */
export function createEnrichChunkWorker(deps: EnrichChunkDeps): Worker {
  return {
    supports: (jobType) => jobType === "enrich_chunk",
    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (!editionId) throw new Error("enrich_chunk job missing edition_id");
      if (!(await deps.editionRepo.isProcessingAllowed(editionId))) return {};
      const chunk = (await deps.chunkRepo.getByDocumentIdOrdered(documentId)).find((row) => row.id === chunkId);
      if (!chunk) { ctx.logger.warn("chunk not found for document, skipping", { chunkId, documentId }); return {}; }
      const prompt = await deps.promptRepo.getLatestVersion(PROMPT_NAME);
      if (!prompt) throw new Error(`prompt '${PROMPT_NAME}' has no registered version; seed default prompts`);
      const result = await deps.promptExecutor.execute({ promptVersion: prompt, provider: deps.provider, model: deps.model, variables: { chunk_text: chunk.content_text } });
      const parsed = extractJson<Record<string, unknown>>(result.content);
      const value = parsed.ok ? parsed.value : {};
      if (!parsed.ok) ctx.logger.warn("combined enrichment returned unusable JSON; using safe fallbacks", { chunkId, documentId, details: parsed.error });
      const summary = string(value.summary) ?? clip(chunk.content_text);
      const claims = Array.isArray(value.claims) ? value.claims.map(string).filter((claim): claim is string => Boolean(claim)) : [];
      const entityInputs = Array.isArray(value.entities) ? value.entities.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const row = raw as Record<string, unknown>; const name = string(row.name); const entityType = string(row.type); const mentionText = string(row.mention);
        return name && entityType && mentionText ? [{ name, entityType, mentionText }] : [];
      }) : [];
      const topicInputs = Array.isArray(value.topics) ? value.topics.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const row = raw as Record<string, unknown>; const topic = string(row.topic); const confidence = unit(row.confidence); const relevance = unit(row.relevance);
        return topic && confidence !== undefined && relevance !== undefined ? [{ topic, confidence, relevance }] : [];
      }) : [];
      const qualityRaw = value.quality && typeof value.quality === "object" ? value.quality as Record<string, unknown> : {};
      const quality = { label: string(qualityRaw.label) ?? "medium", confidence: unit(qualityRaw.confidence) ?? 0, reasoning: qualityRaw.reasoning === null || typeof qualityRaw.reasoning === "string" ? qualityRaw.reasoning : "AI quality classification unavailable; defaulted to medium." };
      const metadata = { promptId: result.promptId, promptVersion: result.promptVersion, model: result.model, provider: result.provider, inputHash: result.inputHash };
      const summaryResult = await deps.summaryRepo.replaceForChunk({ chunkId, documentId, content: summary, ...metadata, claims: (claims.length ? claims : [summary]).map((text) => ({ text, chunkId })) });
      const entities = await deps.entityRepo.replaceForChunk({ chunkId, documentId, ...metadata, entities: entityInputs });
      const topics = await deps.topicRepo.replaceForChunk({ chunkId, documentId, ...metadata, topics: topicInputs });
      const qualityResult = await deps.qualityRepo.replaceForChunk({ chunkId, documentId, ...quality, ...metadata });
      await deps.provenanceRepo.recordLineage({ sourceType: "chunk", sourceId: chunk.id, targetType: "summary", targetId: summaryResult.summary.id, relation: "summarized_by" });
      for (const citation of summaryResult.citations) await deps.provenanceRepo.recordLineage({ sourceType: "summary", sourceId: summaryResult.summary.id, targetType: "chunk", targetId: citation.chunk_id, relation: "cite" });
      for (const entity of entities.entities) await deps.provenanceRepo.recordLineage({ sourceType: "chunk", sourceId: chunk.id, targetType: "entity", targetId: entity.id, relation: "extracted_from" });
      for (const mention of entities.mentions) await deps.provenanceRepo.recordLineage({ sourceType: "entity", sourceId: mention.entity_id, targetType: "chunk", targetId: mention.chunk_id, relation: "mentioned_in" });
      for (const topic of topics.topics) await deps.provenanceRepo.recordLineage({ sourceType: "chunk", sourceId: chunk.id, targetType: "topic", targetId: topic.id, relation: "assigned_to" });
      for (const assignment of topics.assignments) await deps.provenanceRepo.recordLineage({ sourceType: "topic", sourceId: assignment.topic_id, targetType: "chunk", targetId: assignment.chunk_id, relation: "covers" });
      await deps.provenanceRepo.recordLineage({ sourceType: "chunk", sourceId: chunk.id, targetType: "quality_classification", targetId: qualityResult.id, relation: "classified_as" });
      await deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster(editionId, documentId, "enrich_chunk", chunkId);
      return {};
    },
  };
}
