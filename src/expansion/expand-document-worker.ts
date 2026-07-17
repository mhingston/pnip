import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { DocumentRepository } from "./document-repository.js";
import type { SectionRepository } from "./section-repository.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type { ExpansionPlugin, SectionData } from "./types.js";
import type { ProvenanceRepository } from "../provenance/provenance-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";

interface ExpandTarget {
  discoveryEventId: string;
  url: string;
  title?: string;
  partitionKey?: string;
}

function sectionInputs(documentId: string, sections: SectionData[]) {
  return sections.map((section, index) => ({
    documentId,
    order: index,
    heading: section.heading,
    type: section.section_type,
    contentMarkdown: section.content_markdown,
    contentText: section.content_text,
  }));
}

function parseTarget(target: unknown): ExpandTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected object with discoveryEventId and url");
  }
  const t = target as Record<string, unknown>;
  if (typeof t.discoveryEventId !== "string" || typeof t.url !== "string") {
    throw new Error("invalid target: missing discoveryEventId or url");
  }
  return {
    discoveryEventId: t.discoveryEventId,
    url: t.url,
    title: typeof t.title === "string" && t.title.trim().length > 0
      ? t.title.trim()
      : undefined,
    partitionKey: typeof t.partitionKey === "string" ? t.partitionKey : undefined,
  };
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
      const { discoveryEventId, url, title, partitionKey } = parseTarget(job.target);

      const plugin = deps.pluginRegistry.select(url);
      if (!plugin) {
        throw new Error(`no plugin supports URL: ${url}`);
      }

      const expand = async (): Promise<Awaited<ReturnType<ExpansionPlugin["expand"]>> | null> => {
        try {
          return await plugin.expand({
            url,
            editionId: job.edition_id!,
            discoveryEventId,
            title,
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
              target: { discoveryEventId, url, title, partitionKey },
              nextEligibleAt: new Date(Date.now() + err.resetSeconds * 1000),
            });
            return null;
          }
          throw err;
        }
      };

      const existing = await deps.docRepo.getByEditionAndUrl(job.edition_id!, url);
      if (existing) {
        const existingSections = await deps.sectionRepo.getByDocumentId(existing.id);
        if (existingSections.length > 0) {
          ctx.logger.info("document already exists, skipping", { documentId: existing.id });
          return {};
        }

        // A previous attempt may have created the document and then failed
        // while persisting sections. Re-expand and finish that partial row so
        // the retry can emit the chunk job instead of silently accepting a
        // document with content but no sections.
        ctx.logger.warn("repairing existing document without sections", {
          documentId: existing.id,
        });
        const repaired = await expand();
        if (repaired === null) return {};
        if (repaired.sections.length === 0) {
          throw new Error(`expansion produced no sections for ${url}`);
        }
        await deps.sectionRepo.createBatch(sectionInputs(existing.id, repaired.sections));
        await deps.provenanceRepo.recordLineage({
          sourceType: "discovery_event",
          sourceId: discoveryEventId,
          targetType: "document",
          targetId: existing.id,
          relation: "expanded_from",
        });
        return {
          childJobs: [
            {
              jobType: "chunk_document",
              editionId: existing.edition_id,
              target: { documentId: existing.id },
            },
          ],
        };
      }

      const result = await expand();
      if (result === null) return {};
      if (result.sections.length === 0) {
        throw new Error(`expansion produced no sections for ${url}`);
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
        partitionKey,
      });

      if (result.sections.length > 0) {
        await deps.sectionRepo.createBatch(
          sectionInputs(doc.id, result.sections),
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
