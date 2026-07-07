import type { Worker, WorkerContext, WorkerOutcome } from "../jobs/workers/worker.js";
import type { ProcessingJob } from "../database/kysely.js";
import type { RssFetcher } from "./reddit-plugin.js";
import { toRssUrl, parseAtomFeed } from "./reddit-plugin.js";
import { RedditRateLimitError } from "./reddit-rate-limiter.js";
import type { SectionRepository } from "./section-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import {
  selectComments,
  type SelectCommentsOptions,
} from "./comment-selection.js";

export const REFRESH_DELAYS_MS = [
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

interface RefreshTarget {
  documentId: string;
  articleId: string;
  url: string;
  refreshStep: number;
}

function parseTarget(target: unknown): RefreshTarget {
  if (!target || typeof target !== "object") {
    throw new Error("invalid target: expected refresh_reddit_comments target");
  }
  const t = target as Record<string, unknown>;
  if (
    typeof t.documentId !== "string" ||
    typeof t.articleId !== "string" ||
    typeof t.url !== "string" ||
    typeof t.refreshStep !== "number"
  ) {
    throw new Error("invalid target: missing documentId, articleId, url or refreshStep");
  }
  return {
    documentId: t.documentId,
    articleId: t.articleId,
    url: t.url,
    refreshStep: t.refreshStep,
  };
}

export interface RefreshRedditCommentsWorkerDeps {
  redditFetcher: RssFetcher;
  sectionRepo: SectionRepository;
  editionRepo: EditionRepository;
  queue: ProcessingJobQueue;
  selectOpts?: SelectCommentsOptions;
}

export function createRefreshRedditCommentsWorker(
  deps: RefreshRedditCommentsWorkerDeps,
): Worker {
  return {
    supports(jobType: string): boolean {
      return jobType === "refresh_reddit_comments";
    },

    async execute(
      job: ProcessingJob,
      ctx: WorkerContext,
    ): Promise<WorkerOutcome> {
      const { documentId, articleId, url, refreshStep } = parseTarget(job.target);

      const edition = job.edition_id
        ? await deps.editionRepo.getById(job.edition_id)
        : undefined;
      if (!edition || edition.status !== "building") {
        ctx.logger.info("skipping refresh, edition not in building state", {
          editionId: job.edition_id ?? undefined,
          status: edition?.status,
        });
        return {};
      }

      const rssUrl = toRssUrl(url);
      let xml: string;
      try {
        xml = await deps.redditFetcher(rssUrl);
      } catch (err) {
        if (err instanceof RedditRateLimitError) {
          ctx.logger.info("rate limited, deferring refresh", {
            documentId,
            resetSeconds: err.resetSeconds,
          });
          await deps.queue.enqueue({
            jobType: "refresh_reddit_comments",
            editionId: job.edition_id ?? undefined,
            target: { documentId, articleId, url, refreshStep },
            nextEligibleAt: new Date(Date.now() + err.resetSeconds * 1000),
          });
          return {};
        }
        throw err;
      }

      const thread = parseAtomFeed(xml);

      const existingSections = await deps.sectionRepo.getByDocumentIdAndType(
        documentId,
        "reddit_comment",
      );
      const existingIds = new Set(
        existingSections
          .map((s) => (s.metadata as { redditCommentId?: string } | null)?.redditCommentId)
          .filter((id): id is string => typeof id === "string"),
      );
      const newComments = thread.comments.filter((c) => !existingIds.has(c.id));

      const opts: SelectCommentsOptions = deps.selectOpts ?? {
        strategy: "top-n",
        limit: 25,
      };
      const selected = selectComments(newComments, opts);

      if (selected.length > 0) {
        const maxOrder = await deps.sectionRepo.getMaxOrder(documentId);
        const newSections = selected.map((comment, index) => ({
          documentId,
          order: maxOrder + 1 + index,
          heading: `u/${comment.author}`,
          type: "reddit_comment",
          contentMarkdown: comment.body,
          contentText: comment.body,
          metadata: { redditCommentId: comment.id },
        }));
        await deps.sectionRepo.createBatch(newSections);
      } else {
        ctx.logger.info("no new comments to append", { documentId, refreshStep });
      }

      if (refreshStep < REFRESH_DELAYS_MS.length - 1) {
        await deps.queue.enqueue({
          jobType: "refresh_reddit_comments",
          editionId: job.edition_id ?? undefined,
          target: {
            documentId,
            articleId,
            url,
            refreshStep: refreshStep + 1,
          },
          nextEligibleAt: new Date(Date.now() + REFRESH_DELAYS_MS[refreshStep + 1]),
        });
      }

      return {};
    },
  };
}
