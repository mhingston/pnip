import type { Kysely } from "kysely";
import type { Database, Edition } from "../database/kysely.js";
import type { Logger } from "../logging/logger.js";
import {
  EditionNotFoundError,
  type EditionRepository,
} from "../editions/edition-repository.js";
import type { MarkdownDigestRepository } from "../digest/markdown/markdown-digest-repository.js";
import type { EmailDigestRepository } from "../digest/html/email-digest-repository.js";
import type { NotebookRepository } from "../digest/notebooklm/notebook-repository.js";
import type { PodcastRepository } from "../digest/notebooklm/podcast-repository.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { PartitionConfig } from "../config/index.js";
import { PARTITION_MASTER } from "../discovery/partition-resolver.js";
import { getActivePartitions } from "./active-partitions.js";

export class PublicationGateFailedError extends Error {
  readonly editionId: string;
  readonly missingArtifacts: string[];
  constructor(editionId: string, missingArtifacts: string[]) {
    super(
      `publication gate failed for edition ${editionId}: ` +
        `missing artifacts: ${missingArtifacts.join(", ")}`,
    );
    this.name = "PublicationGateFailedError";
    this.editionId = editionId;
    this.missingArtifacts = missingArtifacts;
  }
}

export interface PartitionNotebookStatus {
  partitionKey: string;
  documentCount: number;
  notebookReady: boolean;
  podcastRequired: boolean;
  podcastReady: boolean;
}

export interface CompletionReport {
  markdownExists: boolean;
  markdownNonEmpty: boolean;
  emailSent: boolean;
  notebookReady: boolean;
  podcastReady: boolean;
  partitionNotebooks: PartitionNotebookStatus[];
  missingArtifacts: string[];
}

export interface PublicationServiceResult {
  edition: Edition;
  status: "published" | "already_published" | "publishing";
  alreadyExisted: boolean;
  cancelledJobCount: number;
  completion: CompletionReport;
}

export interface PublishInput {
  editionId: string;
}

export interface PublicationService {
  publish(input: PublishInput): Promise<PublicationServiceResult>;
  publishForDate(input: {
    editionDate: string | Date;
  }): Promise<PublicationServiceResult>;
  checkCompletion(editionId: string): Promise<CompletionReport>;
}

export interface PublicationServiceDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  markdownDigestRepo: MarkdownDigestRepository;
  emailDigestRepo: EmailDigestRepository;
  notebookRepo: NotebookRepository;
  podcastRepo: PodcastRepository;
  jobQueue: ProcessingJobQueue;
  partitionConfig?: PartitionConfig;
  logger?: Logger;
}

const LABEL_MARKDOWN = "markdown digest missing or empty";
const LABEL_EMAIL = "email not sent";
const LABEL_NOTEBOOK = "notebook not ready";
const LABEL_PODCAST = "podcast not ready or no URL";

function partitionNotebookLabel(partitionKey: string): string {
  return `notebook not ready (partition ${partitionKey})`;
}

function partitionPodcastLabel(partitionKey: string): string {
  return `podcast not ready or no URL (partition ${partitionKey})`;
}

function emptyCompletion(): CompletionReport {
  return {
    markdownExists: true,
    markdownNonEmpty: true,
    emailSent: true,
    notebookReady: true,
    podcastReady: true,
    partitionNotebooks: [],
    missingArtifacts: [],
  };
}

export function createPublicationService(
  deps: PublicationServiceDeps,
): PublicationService {
  async function checkCompletion(editionId: string): Promise<CompletionReport> {
    const edition = await deps.editionRepo.getById(editionId);
    if (!edition) {
      throw new EditionNotFoundError(editionId);
    }
    const [markdown, email, notebook, podcast] = await Promise.all([
      deps.markdownDigestRepo.getByEdition(editionId),
      deps.emailDigestRepo.getByEdition(editionId),
      deps.notebookRepo.getByEdition(editionId),
      deps.podcastRepo.getByEdition(editionId),
    ]);

    const markdownExists = markdown !== undefined;
    const markdownNonEmpty =
      markdownExists && markdown.content.length > 0;
    const emailSent = email?.delivery_status === "sent";
    const notebookReady = notebook?.status === "ready";
    const podcastReady = podcast?.status === "ready" && podcast.url !== null;

    const partitionNotebooks: PartitionNotebookStatus[] = [];
    const partitionConfig = deps.partitionConfig ?? {};
    const hasConfiguredPartitions = Object.keys(partitionConfig).length > 0;

    if (hasConfiguredPartitions) {
      const activePartitions = await getActivePartitions({
        db: deps.db,
        editionId,
        config: partitionConfig,
      });

      for (const ap of activePartitions) {
        if (ap.partitionKey === PARTITION_MASTER) continue;
        const partitionNotebook =
          await deps.notebookRepo.getByEditionAndPartition(
            editionId,
            ap.partitionKey,
          );
        const partNotebookReady = partitionNotebook?.status === "ready";
        let partPodcastReady = true;
        if (ap.withPodcast) {
          if (!partitionNotebook) {
            partPodcastReady = false;
          } else {
            const partitionPodcast =
              await deps.podcastRepo.getByNotebookId(partitionNotebook.id);
            partPodcastReady =
              partitionPodcast?.status === "ready" &&
              partitionPodcast.url !== null;
          }
        }
        partitionNotebooks.push({
          partitionKey: ap.partitionKey,
          documentCount: ap.documentCount,
          notebookReady: partNotebookReady,
          podcastRequired: ap.withPodcast,
          podcastReady: partPodcastReady,
        });
      }
    }

    const missingArtifacts: string[] = [];
    if (!markdownNonEmpty) missingArtifacts.push(LABEL_MARKDOWN);
    if (!emailSent) missingArtifacts.push(LABEL_EMAIL);
    if (!notebookReady) missingArtifacts.push(LABEL_NOTEBOOK);
    if (!podcastReady) missingArtifacts.push(LABEL_PODCAST);
    for (const pn of partitionNotebooks) {
      if (!pn.notebookReady) {
        missingArtifacts.push(partitionNotebookLabel(pn.partitionKey));
      }
      if (pn.podcastRequired && !pn.podcastReady) {
        missingArtifacts.push(partitionPodcastLabel(pn.partitionKey));
      }
    }

    return {
      markdownExists,
      markdownNonEmpty,
      emailSent,
      notebookReady,
      podcastReady,
      partitionNotebooks,
      missingArtifacts,
    };
  }

  async function publish(
    input: PublishInput,
  ): Promise<PublicationServiceResult> {
    const edition = await deps.editionRepo.getById(input.editionId);
    if (!edition) {
      throw new EditionNotFoundError(input.editionId);
    }

    if (edition.status === "published") {
      return {
        edition,
        status: "already_published",
        alreadyExisted: true,
        cancelledJobCount: 0,
        completion: emptyCompletion(),
      };
    }
    if (edition.status === "publishing") {
      return {
        edition,
        status: "publishing",
        alreadyExisted: false,
        cancelledJobCount: 0,
        completion: emptyCompletion(),
      };
    }

    const completion = await checkCompletion(input.editionId);
    if (completion.missingArtifacts.length > 0) {
      throw new PublicationGateFailedError(
        input.editionId,
        completion.missingArtifacts,
      );
    }

    deps.logger?.info("publication gate passed", {
      editionId: input.editionId,
    });

    await deps.editionRepo.transition(input.editionId, "publishing");
    const publishedEdition = await deps.editionRepo.transition(
      input.editionId,
      "published",
    );

    const cancelledJobCount = await deps.jobQueue.cancelForEdition({
      editionId: input.editionId,
      reason: `cancelled by publication of edition ${input.editionId}`,
    });

    deps.logger?.info("edition published", {
      editionId: input.editionId,
      cancelledJobCount,
    });

    return {
      edition: publishedEdition,
      status: "published",
      alreadyExisted: false,
      cancelledJobCount,
      completion,
    };
  }

  async function publishForDate(input: {
    editionDate: string | Date;
  }): Promise<PublicationServiceResult> {
    const edition = await deps.editionRepo.getByDate(input.editionDate);
    if (!edition) {
      throw new Error(
        `no edition found for date ${String(input.editionDate)}`,
      );
    }
    return publish({ editionId: edition.id });
  }

  return {
    checkCompletion,
    publish,
    publishForDate,
  };
}
