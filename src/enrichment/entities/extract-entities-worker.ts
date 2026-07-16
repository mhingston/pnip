import type { Worker, WorkerContext, WorkerOutcome } from "../../jobs/workers/worker.js";
import type { ProcessingJob, PromptVersion } from "../../database/kysely.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { PromptRepository } from "../../prompts/prompt-repository.js";
import type { PromptExecutionService } from "../../ai/prompt-execution.js";
import type { AiProvider } from "../../ai/provider.js";
import type { ProvenanceRepository } from "../../provenance/provenance-repository.js";
import type { EntityRepository } from "./entity-repository.js";
import type { EnrichmentGateService } from "../../editions/enrichment-gate-service.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import { extractJson } from "../../common/json-extract.js";

const ENTITIES_PROMPT_NAME = "entities";
const ENRICHMENT_TYPE = "extract_entities";

export interface ExtractEntitiesDeps {
  chunkRepo: ChunkRepository;
  entityRepo: EntityRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  provenanceRepo: ProvenanceRepository;
  gate: EnrichmentGateService;
  editionRepo: EditionRepository;
  model?: string;
}

interface EntitiesResponse {
  entities?: unknown;
}

interface RawEntity {
  name: unknown;
  type: unknown;
  mention: unknown;
}

function isEntityArray(v: unknown): v is RawEntity[] {
  return Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

interface ChunkTarget {
  chunkId: string;
  documentId: string;
}

function parseTarget(target: unknown): ChunkTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with chunkId and documentId");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.chunkId !== "string" || typeof t.documentId !== "string") {
    throw new Error("invalid target: missing chunkId or documentId");
  }
  return { chunkId: t.chunkId, documentId: t.documentId };
}

export function createExtractEntitiesWorker(deps: ExtractEntitiesDeps): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "extract_entities";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { chunkId, documentId } = parseTarget(job.target);
      const editionId = job.edition_id;
      if (typeof editionId !== "string") {
        throw new Error("extract_entities job missing edition_id");
      }

      const allowed = await deps.editionRepo.isProcessingAllowed(editionId);
      if (!allowed) {
        ctx.logger.info("edition not in mutable state, skipping extract_entities", {
          editionId,
          documentId,
          chunkId,
        });
        return {};
      }

      const chunk = await deps.chunkRepo.getByDocumentIdOrdered(documentId);
      const found = chunk.find((c) => c.id === chunkId);
      if (!found) {
        ctx.logger.warn("chunk not found for document, skipping", {
          chunkId,
          documentId,
        });
        return {};
      }

      const prompt: PromptVersion | undefined =
        await deps.promptRepo.getLatestVersion(ENTITIES_PROMPT_NAME);
      if (!prompt) {
        throw new Error(
          `prompt '${ENTITIES_PROMPT_NAME}' has no registered version; seed default prompts`,
        );
      }

      const result = await deps.promptExecutor.execute({
        promptVersion: prompt,
        provider: deps.provider,
        model: deps.model,
        variables: {
          chunk_text: found.content_text,
        },
      });

      const normalized: { name: string; entityType: string; mentionText: string }[] = [];
      const seen = new Set<string>();
      let duplicateCount = 0;
      const extracted = extractJson<EntitiesResponse>(result.content);
      if (!extracted.ok) {
        ctx.logger.warn("entities prompt returned unusable JSON; using empty entity fallback", {
          chunkId,
          documentId,
          details: extracted.error,
        });
      } else if (!isEntityArray(extracted.value.entities)) {
        ctx.logger.warn("entities prompt omitted its entity array; using empty entity fallback", {
          chunkId,
          documentId,
        });
      } else {
        let invalidCount = 0;
        for (const raw of extracted.value.entities) {
          if (!isString(raw.name) || !isString(raw.type) || !isString(raw.mention)) {
            invalidCount++;
            continue;
          }
          const name = raw.name.trim();
          const entityType = raw.type.trim();
          const mentionText = raw.mention.trim();
          if (!name || !entityType || !mentionText) {
            invalidCount++;
            continue;
          }
          const key = `${name}\u0000${entityType}`;
          if (seen.has(key)) {
            duplicateCount++;
            continue;
          }
          seen.add(key);
          normalized.push({
            name,
            entityType,
            mentionText,
          });
        }
        if (invalidCount > 0) {
          ctx.logger.warn("invalid entities omitted from enrichment result", {
            chunkId,
            documentId,
            invalidCount,
          });
        }
      }

      if (duplicateCount > 0) {
        ctx.logger.warn("duplicate entities suppressed", {
          chunkId,
          documentId,
          duplicateCount,
        });
      }

      const { entities, mentions } = await deps.entityRepo.replaceForChunk({
        chunkId,
        documentId,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        model: result.model,
        provider: result.provider,
        inputHash: result.inputHash,
        entities: normalized,
      });

      for (const e of entities) {
        await deps.provenanceRepo.recordLineage({
          sourceType: "chunk",
          sourceId: chunkId,
          targetType: "entity",
          targetId: e.id,
          relation: "extracted_from",
        });
      }

      for (const m of mentions) {
        await deps.provenanceRepo.recordLineage({
          sourceType: "entity",
          sourceId: m.entity_id,
          targetType: "chunk",
          targetId: chunkId,
          relation: "mentioned_in",
        });
      }

      ctx.logger.info("entities extracted", {
        chunkId,
        documentId,
        entityCount: entities.length,
      });

      const childJob = await deps.gate.markEnrichmentDoneAndMaybeEnqueueCluster(
        editionId,
        documentId,
        ENRICHMENT_TYPE,
        chunkId,
      );
      return childJob ? { childJobs: [childJob] } : {};
    },
  };
}
