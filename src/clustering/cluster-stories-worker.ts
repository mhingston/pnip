import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { SummaryRepository } from "../enrichment/summary/summary-repository.js";
import type { TopicRepository } from "../enrichment/topics/topic-repository.js";
import type { EmbeddingRepository } from "../enrichment/embeddings/embedding-repository.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { StoryRepository } from "./story-repository.js";
import {
  clusterDocuments,
  type DocumentClusterInput,
  type ClusterOptions,
} from "./clustering-service.js";

const CLUSTER_JOB_TYPE = "cluster_stories";
const SUMMARIZE_STORY_JOB_TYPE = "summarize_story";

export interface ClusterStoriesDeps {
  docRepo: DocumentRepository;
  summaryRepo: SummaryRepository;
  topicRepo: TopicRepository;
  embeddingRepo: EmbeddingRepository;
  storyRepo: StoryRepository;
  provenanceRepo: ProvenanceRepository;
  options?: Partial<ClusterOptions>;
}

interface ClusterTarget {
  editionId: string;
}

function parseTarget(target: unknown): ClusterTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with editionId");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.editionId !== "string") {
    throw new Error("invalid target: missing editionId");
  }
  return { editionId: t.editionId };
}

function averageEmbedding(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= vectors.length;
  return acc;
}

export function createClusterStoriesWorker(
  deps: ClusterStoriesDeps,
): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === CLUSTER_JOB_TYPE;
    },

    async execute(
      job: ProcessingJob,
      ctx: WorkerContext,
    ): Promise<WorkerOutcome> {
      const { editionId } = parseTarget(job.target);

      const documents = await deps.docRepo.getByEdition(editionId);
      if (documents.length === 0) {
        ctx.logger.info("no documents to cluster, clearing stories", { editionId });
        await deps.storyRepo.deleteByEdition(editionId);
        return {};
      }

      const inputs: DocumentClusterInput[] = [];

      for (const doc of documents) {
        const summaries = await deps.summaryRepo.getByDocumentId(doc.id);
        if (summaries.length === 0) continue;
        const summaryText = summaries
          .map((s) => s.content)
          .join(" ");

        const topics = await deps.topicRepo.getByDocumentId(doc.id);
        const topicList = Array.from(
          new Set(topics.map((t) => t.topic.trim().toLowerCase())),
        ).filter((t) => t.length > 0);

        const embeddings = await deps.embeddingRepo.getByDocumentId(doc.id);
        if (embeddings.length === 0) continue;
        const vector = averageEmbedding(embeddings.map((e) => e.vector));

        inputs.push({
          documentId: doc.id,
          summary: summaryText,
          topics: topicList,
          embedding: vector,
          publishedAt: doc.published_at,
        });
      }

      if (inputs.length === 0) {
        ctx.logger.info("no documents with summaries+embeddings, clearing stories", {
          editionId,
        });
        await deps.storyRepo.deleteByEdition(editionId);
        return {};
      }

      const clusters = clusterDocuments(inputs, deps.options);

      const { stories } = await deps.storyRepo.replaceForEdition({
        editionId,
        stories: clusters,
      });

      await deps.provenanceRepo.recordLineageBatch(
        stories.flatMap((s) =>
          s.members.map((m) => ({
            sourceType: "document" as const,
            sourceId: m.document_id,
            targetType: "story" as const,
            targetId: s.story.id,
            relation: "clustered_into",
          })),
        ),
      );

      ctx.logger.info("stories clustered", {
        editionId,
        documentCount: inputs.length,
        storyCount: stories.length,
      });

      const childJobs = stories.map((s) => ({
        jobType: SUMMARIZE_STORY_JOB_TYPE,
        editionId,
        target: { storyId: s.story.id },
      }));

      return { childJobs };
    },
  };
}
