import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "./document-repository.js";
import type { SectionRepository } from "./section-repository.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";

interface ExpandTarget {
  discoveryEventId: string;
  url: string;
}

function parseTarget(target: unknown): ExpandTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with discoveryEventId and url");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.discoveryEventId !== "string" || typeof t.url !== "string") {
    throw new Error("invalid target: missing discoveryEventId or url");
  }
  return { discoveryEventId: t.discoveryEventId, url: t.url };
}

export function createExpandDocumentWorker(deps: {
  docRepo: DocumentRepository;
  sectionRepo: SectionRepository;
  pluginRegistry: PluginRegistry;
  provenanceRepo: ProvenanceRepository;
  queue: ProcessingJobQueue;
}): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "expand_document";
    },

    async execute(job: ProcessingJob, ctx: WorkerContext): Promise<WorkerOutcome> {
      const { discoveryEventId, url } = parseTarget(job.target);

      const plugin = deps.pluginRegistry.select(url);
      if (!plugin) {
        throw new Error(`no plugin supports URL: ${url}`);
      }

      const existing = await deps.docRepo.getByEditionAndUrl(job.edition_id!, url);
      if (existing) {
        ctx.logger.info("document already exists, skipping", { documentId: existing.id });
        return {};
      }

      let result;
      try {
        result = await plugin.expand({
          url,
          editionId: job.edition_id!,
          discoveryEventId,
        });
      } catch (err) {
        if (err instanceof RedditRateLimitError) {
          ctx.logger.info("rate limited, deferring expansion", {
            url,
            resetSeconds: err.resetSeconds,
          });
          await deps.queue.enqueue({
            jobType: "expand_document",
            editionId: job.edition_id ?? undefined,
            target: { discoveryEventId, url },
            nextEligibleAt: new Date(Date.now() + err.resetSeconds * 1000),
          });
          return {};
        }
        throw err;
      }

      const doc = await deps.docRepo.create({
        editionId: job.edition_id!,
        sourceType: result.sourceType,
        sourceUrl: url,
        title: result.title,
        contentMarkdown: result.content,
        contentText: result.plainText,
        canonicalUrl: result.canonicalUrl,
        authors: result.authors,
        publishedAt: result.publishedAt,
        language: result.language,
        metadata: result.metadata,
      });

      if (result.sections.length > 0) {
        await deps.sectionRepo.createBatch(
          result.sections.map((s) => ({
            documentId: doc.id,
            order: s.order,
            heading: s.heading,
            type: s.section_type,
            contentMarkdown: s.content_markdown,
            contentText: s.content_text,
          })),
        );
      }

      await deps.provenanceRepo.recordLineage({
        sourceType: "discovery_event",
        sourceId: discoveryEventId,
        targetType: "document",
        targetId: doc.id,
        relation: "expanded_from",
      });

      return {
        childJobs: [
          {
            jobType: "chunk_document",
            editionId: doc.edition_id,
            target: { documentId: doc.id },
          },
        ],
      };
    },
  };
}
