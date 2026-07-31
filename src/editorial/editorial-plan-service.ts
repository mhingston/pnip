import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { AiProvider } from "../ai/provider.js";
import type { PromptExecutionService } from "../ai/prompt-execution.js";
import type { Database, EditorialPlanRow } from "../database/kysely.js";
import type { ChunkRepository } from "../chunking/chunk-repository.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SummaryRepository } from "../enrichment/summary/summary-repository.js";
import type { PromptRepository } from "../prompts/prompt-repository.js";
import type { SourceTrustRepository } from "../signals/source-trust-repository.js";
import type { SignalRepository } from "../signals/signal-repository.js";
import type { StoryRepository } from "../clustering/story-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { EnrichmentTrackerRepository } from "../editions/enrichment-tracker-repository.js";
import { buildEditorialItemBrief, sortEditorialBriefs, type EditorialItemBrief } from "./editorial-item-brief.js";
import { EditorialPlanSchema, type EditorialPlan } from "./editorial-plan-schema.js";
import { validateEditorialPlan } from "./editorial-plan-validator.js";
import { createSingletonFallback } from "./editorial-plan-fallback.js";
import type { EditorialPlanRepository } from "./editorial-plan-repository.js";
import { extractJson } from "../common/json-extract.js";
import { deriveSourceIdentity } from "../signals/source-identity.js";

const PROMPT_NAME = "edition_editorial_plan";
const CONTRACT_VERSION = "editorial-plan-v1";
const MAX_DOCUMENTS = 100;

export interface EditorialCompositionResult {
  editionId: string;
  documentCount: number;
  storyCount: number;
  inputHash: string;
  status: "generated" | "reused" | "repaired" | "fallback";
  plan: EditorialPlan;
}

export interface EditorialPlanServiceDeps {
  db: Kysely<Database>;
  docRepo: DocumentRepository;
  chunkRepo: ChunkRepository;
  summaryRepo: SummaryRepository;
  promptRepo: PromptRepository;
  promptExecutor: PromptExecutionService;
  provider: AiProvider;
  planRepo: EditorialPlanRepository;
  storyRepo: StoryRepository;
  queue: ProcessingJobQueue;
  enrichmentTracker: EnrichmentTrackerRepository;
  sourceTrustRepo: SourceTrustRepository;
  signalRepo?: SignalRepository;
  model?: string;
  maxDocuments?: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hashInput(editionId: string, briefs: readonly EditorialItemBrief[], prompt: { name: string; version: number }, model: string, provider: string): string {
  const canonical = { contract: CONTRACT_VERSION, editionId, prompt, model, provider, items: briefs.map((b) => ({ id: b.documentId, summary: b.summary, evidence: b.evidence, trust: b.sourceTrustTier, boost: b.sourcePriorityBoost })) };
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function renderItems(briefs: readonly EditorialItemBrief[]): string { return JSON.stringify(briefs, null, 2); }

function parsePlan(content: string): EditorialPlan {
  const extracted = extractJson(content);
  if (!extracted.ok) throw new Error(extracted.error);
  return EditorialPlanSchema.parse(extracted.value);
}

export function createEditorialPlanService(deps: EditorialPlanServiceDeps) {
  return {
    async compose(editionId: string): Promise<EditorialCompositionResult> {
      const docs = await deps.docRepo.getByEdition(editionId);
      const maxDocuments = deps.maxDocuments ?? MAX_DOCUMENTS;
      if (docs.length > maxDocuments) throw new Error(`edition has ${docs.length} documents; editorial planner limit is ${maxDocuments}`);
      const completionRows = await deps.db.selectFrom("documents").leftJoin("document_enrichment_status", "document_enrichment_status.document_id", "documents.id").select("documents.id").select((eb) => eb.fn.count("document_enrichment_status.document_id").filterWhere("document_enrichment_status.enrichment_type", "=", "enrich_chunk").filterWhere("document_enrichment_status.status", "=", "done").as("completed")).where("documents.edition_id", "=", editionId).groupBy("documents.id").execute();
      if (completionRows.length === 0 || completionRows.some((row) => Number(row.completed) === 0)) throw new Error("edition is not fully enriched");
      const trust = new Map((await deps.sourceTrustRepo.getAll()).map((row) => [row.source_identity, row.tier]));
      const briefs = sortEditorialBriefs(await Promise.all(docs.map(async (document) => buildEditorialItemBrief({
        document, summaries: await deps.summaryRepo.getByDocumentId(document.id), chunks: await deps.chunkRepo.getByDocumentIdOrdered(document.id), sourceTrustTier: trust.get(deriveSourceIdentity({ sourceUrl: document.source_url, sourceType: document.source_type, publisher: document.publisher, metadata: document.metadata }) ?? "") ?? null,
      }))));
      const prompt = await deps.promptRepo.getLatestVersion(PROMPT_NAME);
      if (!prompt) throw new Error(`prompt '${PROMPT_NAME}' is not seeded`);
      const model = deps.model ?? "";
      const providerName = deps.provider.name;
      const inputHash = hashInput(editionId, briefs, prompt, model, providerName);
      const existing = await deps.planRepo.getByEdition(editionId);
      if (existing?.input_hash === inputHash) {
        const plan = EditorialPlanSchema.parse(typeof existing.plan === "string" ? JSON.parse(existing.plan) : existing.plan);
        return { editionId, documentCount: docs.length, storyCount: plan.stories.length, inputHash, status: "reused", plan };
      }
      let plan: EditorialPlan = createSingletonFallback(briefs);
      let status: EditorialCompositionResult["status"] = "generated";
      let usedFallback = false;
      const variables = { item_briefs: renderItems(briefs), schema: JSON.stringify(EditorialPlanSchema.toString()), contract_version: CONTRACT_VERSION };
      let firstContent: string;
      try {
        firstContent = (await deps.promptExecutor.execute({ promptVersion: prompt, variables, provider: deps.provider, model })).content;
      } catch {
        plan = createSingletonFallback(briefs);
        status = "fallback";
        usedFallback = true;
        firstContent = "";
      }
      if (!usedFallback) {
        let errors = [] as ReturnType<typeof validateEditorialPlan>;
        try {
          plan = parsePlan(firstContent);
          errors = validateEditorialPlan({ plan, documentIds: docs.map((d) => d.id) });
        } catch (error) {
          errors = [{ code: "input_changed", message: error instanceof Error ? error.message : String(error) }];
        }
        if (errors.length > 0) {
          try {
            const repaired = await deps.promptExecutor.execute({ promptVersion: prompt, variables: { ...variables, invalid_response: firstContent, validation_errors: JSON.stringify(errors) }, provider: deps.provider, model });
            plan = parsePlan(repaired.content);
            errors = validateEditorialPlan({ plan, documentIds: docs.map((d) => d.id) });
            if (errors.length > 0) throw new Error(`editorial plan repair failed: ${errors.map((e) => e.code).join(", ")}`);
            status = "repaired";
          } catch {
            plan = createSingletonFallback(briefs);
            status = "fallback";
            usedFallback = true;
          }
        }
      }
      const currentDocuments = await deps.docRepo.getByEdition(editionId);
      const expectedIds = docs.map((document) => document.id).sort().join(",");
      const currentIds = currentDocuments.map((document) => document.id).sort().join(",");
      if (expectedIds !== currentIds) throw new Error("edition composition input changed before plan application");
      const applied = await deps.storyRepo.replaceForEditionIfNoActiveSummaries({ editionId, stories: plan.stories.map((story) => ({ label: story.title.trim(), documentIds: [ ...story.documentIds ] })) });
      if (!applied) throw new Error("edition has active story-summary jobs; composition deferred");
      await deps.planRepo.save({ editionId, inputHash, plan, promptId: prompt.id, promptVersion: prompt.version, model, provider: providerName, usedFallback });
      if (deps.signalRepo) {
        await deps.signalRepo.createBatch(applied.stories.flatMap((story) => story.members.map((member) => ({
          signal_kind: "clustered_into_story",
          edition_id: editionId,
          story_id: story.story.id,
          document_id: member.document_id,
          payload: { method: "llm_editorial_plan", usedFallback },
        }))));
      }
      for (const story of applied.stories) await deps.queue.enqueue({ jobType: "summarize_story", editionId, target: { storyId: story.story.id } });
      return { editionId, documentCount: docs.length, storyCount: plan.stories.length, inputHash, status, plan };
    },
  };
}
