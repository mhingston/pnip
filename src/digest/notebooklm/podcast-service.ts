import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Logger } from "../../logging/logger.js";
import type { Kysely } from "kysely";
import type { Database, Edition } from "../../database/kysely.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type { MarkdownDigestRepository } from "../markdown/markdown-digest-repository.js";
import type { NotebookRepository } from "./notebook-repository.js";
import {
  type PodcastRepository,
  type PodcastRow,
  PodcastConflictError,
} from "./podcast-repository.js";
import {
  NotebookLmError,
  type GenerateAudioInput,
  type GenerateAudioResult,
  type NotebookLmClient,
} from "./notebooklm-client.js";

export interface PodcastServiceConfig {
  format?: "deep-dive" | "brief" | "critique" | "debate";
  length?: "short" | "default" | "long";
  language?: string;
  instructions?: string;
  artifactWaitTimeoutSec?: number;
  artifactPollIntervalSec?: number;
  outputDir?: string;
}

export interface PodcastServiceDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  markdownDigestRepo: MarkdownDigestRepository;
  notebookRepo: NotebookRepository;
  podcastRepo: PodcastRepository;
  notebookLm: NotebookLmClient;
  config?: PodcastServiceConfig;
  logger?: Logger;
}

export interface PodcastServiceResult {
  podcastId: string;
  edition: Edition;
  artifactExternalId: string;
  url: string | null;
  localPath: string | null;
  durationSeconds: number | null;
  status: "ready" | "generating" | "failed" | "skipped";
  alreadyExisted: boolean;
  failureReason: string | null;
  partitionKey: string;
}

export interface GeneratePodcastInput {
  editionId: string;
  partitionKey?: string;
  /**
   * When true (opt-in), the call blocks until NotebookLM finishes generating
   * the audio, then downloads the file and marks the row `ready`. Default
   * false — the call is fire-and-forget; the row is left in `generating`
   * with the artifact id and the operator re-runs later (or runs with
   * `wait: true`) to fetch the URL.
   */
  wait?: boolean;
}

export interface PodcastService {
  generate(input: GeneratePodcastInput): Promise<PodcastServiceResult>;
  generateForDate(input: {
    editionDate: string | Date;
    partitionKey?: string;
    wait?: boolean;
  }): Promise<PodcastServiceResult>;
}

const DEFAULT_FORMAT: "deep-dive" = "deep-dive";
const DEFAULT_LENGTH: "default" = "default";
const DEFAULT_PARTITION_KEY = "master";
const DEFAULT_INSTRUCTIONS =
  "Produce a deep-dive conversational audio overview of this edition's curated sources and digest narrative. Highlight cross-source themes, factual claims, and any points of disagreement. Speak to an informed general audience.";
const DEFAULT_ARTIFACT_WAIT_TIMEOUT_SEC = 1500;
const DEFAULT_ARTIFACT_POLL_INTERVAL_SEC = 30;
const PENDING_ARTIFACT_PLACEHOLDER = "pending";

function formatPublicationDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function failureReasonOf(err: unknown): string {
  if (err instanceof NotebookLmError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function resolveOutputDir(configDir: string | undefined): string {
  if (configDir && configDir.length > 0) return configDir;
  const env = process.env.NOTEBOOKLM_OUTPUT_DIR;
  if (env && env.length > 0) return env;
  return "./notebooks";
}

export function createPodcastService(
  deps: PodcastServiceDeps,
): PodcastService {
  function resolveEdition(editionId: string): Promise<Edition> {
    return deps.editionRepo.getById(editionId).then((ed) => {
      if (!ed) throw new Error(`edition not found: ${editionId}`);
      return ed;
    });
  }

  function rowToResult(
    row: PodcastRow,
    edition: Edition,
    options: { alreadyExisted: boolean; failureReason?: string | null },
  ): PodcastServiceResult {
    return {
      podcastId: row.id,
      edition,
      artifactExternalId: row.artifact_external_id,
      url: row.url,
      localPath: row.local_path,
      durationSeconds: row.duration_seconds,
      status: row.status as "ready" | "generating" | "failed" | "skipped",
      alreadyExisted: options.alreadyExisted,
      failureReason: options.failureReason ?? row.failure_reason ?? null,
      partitionKey: row.partition_key,
    };
  }

  async function ensureFailedRow(input: {
    editionId: string;
    partitionKey: string;
    row: PodcastRow | null;
    notebookId: string | null;
    reason: string;
  }): Promise<void> {
    if (input.row) {
      try {
        await deps.podcastRepo.updateDelivery(input.row.id, {
          status: "failed",
          failureReason: input.reason,
          completedAt: new Date(),
        });
      } catch (updateErr) {
        deps.logger?.error("podcast: failed to mark existing row failed", {
          editionId: input.editionId,
          partitionKey: input.partitionKey,
          podcastId: input.row.id,
          reason: input.reason,
          error:
            updateErr instanceof Error ? updateErr : new Error(String(updateErr)),
        });
      }
      return;
    }
    if (!input.notebookId) return;
    try {
      await deps.podcastRepo.createForEdition({
        editionId: input.editionId,
        partitionKey: input.partitionKey,
        notebookId: input.notebookId,
        artifactExternalId: PENDING_ARTIFACT_PLACEHOLDER,
        status: "failed",
        failureReason: input.reason,
      });
    } catch (err) {
      if (err instanceof PodcastConflictError) {
        const after = await deps.podcastRepo.getByNotebookId(input.notebookId);
        if (after) {
          await deps.podcastRepo.updateDelivery(after.id, {
            status: "failed",
            failureReason: input.reason,
            completedAt: new Date(),
          });
        }
        return;
      }
      throw err;
    }
  }

  async function generate(input: GeneratePodcastInput): Promise<PodcastServiceResult> {
    const partitionKey = input.partitionKey ?? DEFAULT_PARTITION_KEY;
    const edition = await resolveEdition(input.editionId);

    const markdown = await deps.markdownDigestRepo.getByEdition(
      input.editionId,
    );
    if (!markdown) {
      throw new Error(
        `no markdown digest for edition ${input.editionId}; ` +
          `run "digestive generate-digest --date ${formatPublicationDate(
            edition.publication_date,
          )}" first`,
      );
    }

    const notebook = await deps.notebookRepo.getByEditionAndPartition(
      input.editionId,
      partitionKey,
    );
    if (!notebook) {
      throw new Error(
        `no notebook for edition ${input.editionId} partition '${partitionKey}'; ` +
          `run "digestive generate-notebook --date ${formatPublicationDate(
            edition.publication_date,
          )} --partition ${partitionKey}" first`,
      );
    }
    if (notebook.status !== "ready") {
      throw new Error(
        `notebook for edition ${input.editionId} partition '${partitionKey}' is in status '${notebook.status}'; ` +
          `audio generation requires all sources to be ingested (status='ready'). ` +
          `Re-run "digestive generate-notebook --date ${formatPublicationDate(
            edition.publication_date,
          )} --partition ${partitionKey} --wait" to poll until the notebook is ready, then run generate-podcast again.`,
      );
    }

    const existing = await deps.podcastRepo.getByNotebookId(notebook.id);
    if (existing && existing.status === "ready" && existing.url) {
      deps.logger?.info(
        "podcast already ready for edition; idempotent return",
        {
          editionId: input.editionId,
          partitionKey,
          notebookId: notebook.id,
          podcastId: existing.id,
        },
      );
      return rowToResult(existing, edition, { alreadyExisted: true });
    }

    const instructions =
      deps.config?.instructions ?? DEFAULT_INSTRUCTIONS;
    const format = deps.config?.format ?? DEFAULT_FORMAT;
    const length = deps.config?.length ?? DEFAULT_LENGTH;
    const language = deps.config?.language;
    const artifactWaitTimeoutSec =
      deps.config?.artifactWaitTimeoutSec ?? DEFAULT_ARTIFACT_WAIT_TIMEOUT_SEC;
    const artifactPollIntervalSec =
      deps.config?.artifactPollIntervalSec ?? DEFAULT_ARTIFACT_POLL_INTERVAL_SEC;
    const outputDir = resolveOutputDir(deps.config?.outputDir);
    const destinationPath = isAbsolute(outputDir)
      ? join(outputDir, `${input.editionId}.mp3`)
      : join(process.cwd(), outputDir, `${input.editionId}.mp3`);
    const wait = input.wait ?? false;

    let row: PodcastRow | null = existing ?? null;
    let generation: GenerateAudioResult;
    let resumingExistingArtifact = false;

    try {
      if (!row) {
        try {
          row = await deps.podcastRepo.createForEdition({
            editionId: input.editionId,
            partitionKey,
            notebookId: notebook.id,
            artifactExternalId: PENDING_ARTIFACT_PLACEHOLDER,
            format,
            language: language ?? null,
            status: "pending",
            providerResponse: { phase: "pending" },
          });
        } catch (err) {
          if (err instanceof PodcastConflictError) {
            const after = await deps.podcastRepo.getByNotebookId(notebook.id);
            if (after && after.status === "ready" && after.url) {
              deps.logger?.info(
                "podcast race resolved; returning existing ready row",
                {
                  editionId: input.editionId,
                  partitionKey,
                  notebookId: notebook.id,
                  podcastId: after.id,
                },
              );
              return rowToResult(after, edition, { alreadyExisted: true });
            }
            if (after && after.status === "generating") {
              return rowToResult(after, edition, {
                alreadyExisted: true,
                failureReason:
                  "podcast generation in progress; re-run with --wait to fetch the URL when ready",
              });
            }
            throw err;
          }
          throw err;
        }
      }

      if (
        row.status === "generating" &&
        row.artifact_external_id !== PENDING_ARTIFACT_PLACEHOLDER
      ) {
        if (!wait) {
          return rowToResult(row, edition, {
            alreadyExisted: true,
            failureReason:
              "podcast generation already in progress; re-run with --wait to fetch the URL when ready",
          });
        }
        // A retry must resume the provider artifact rather than issuing a
        // second generate-audio request for the same notebook.
        resumingExistingArtifact = true;
        generation = {
          taskId: row.artifact_external_id,
          status: "pending",
          url: null,
        };
      } else {
        const generateInput: GenerateAudioInput = {
          notebookExternalId: notebook.notebook_external_id,
          instructions,
          format,
          length,
          wait,
          timeoutSec: artifactWaitTimeoutSec,
        };
        if (language !== undefined) {
          generateInput.language = language;
        }

        generation = await deps.notebookLm.generateAudio(generateInput);

        if (!wait) {
          row = await deps.podcastRepo.updateDelivery(row.id, {
            status: "generating",
            artifactExternalId: generation.taskId,
            startedAt: new Date(),
            url: generation.url,
            providerResponse: {
              phase: "generating",
              fireAndForget: true,
              generation,
            },
          });

          deps.logger?.info("podcast generation kicked off", {
            editionId: input.editionId,
            partitionKey,
            notebookId: notebook.id,
            podcastId: row.id,
            artifactExternalId: row.artifact_external_id,
          });

          return rowToResult(row, edition, {
            alreadyExisted: false,
            failureReason: `fire-and-forget; re-run with --wait once the artifact is ready to fetch the URL and download the mp3`,
          });
        }
      }

      let resolvedUrl: string | null = resumingExistingArtifact
        ? null
        : generation.url;
      if (resolvedUrl === null) {
        const waited = await deps.notebookLm.waitForArtifact({
          notebookExternalId: notebook.notebook_external_id,
          artifactExternalId: generation.taskId,
          timeoutSec: artifactWaitTimeoutSec,
          pollIntervalMs: artifactPollIntervalSec * 1000,
        });
        if (waited.status === "timeout") {
          await deps.podcastRepo.updateDelivery(row.id, {
            status: "failed",
            artifactExternalId: generation.taskId,
            providerResponse: {
              phase: "wait-timeout",
              taskId: generation.taskId,
              generation,
            },
            failureReason: `NotebookLM artifact ${generation.taskId} did not complete within ${artifactWaitTimeoutSec}s`,
            completedAt: new Date(),
          });
          const refreshed = await deps.podcastRepo.getById(row.id);
          if (!refreshed) {
            throw new Error(
              `podcast row vanished after timeout: ${row.id}`,
            );
          }
          return rowToResult(refreshed, edition, {
            alreadyExisted: false,
            failureReason: refreshed.failure_reason,
          });
        }
        resolvedUrl = waited.url;
      }

      row = await deps.podcastRepo.updateDelivery(row.id, {
        status: "generating",
        artifactExternalId: generation.taskId,
        url: resolvedUrl,
        startedAt: new Date(),
        providerResponse: {
          phase: "generating",
          generation,
        },
      });

      let downloadedPath: string | null = null;
      let downloadFailure: string | null = null;
      try {
        await mkdir(outputDir, { recursive: true });
        const downloaded = await deps.notebookLm.downloadAudio({
          notebookExternalId: notebook.notebook_external_id,
          artifactExternalId: generation.taskId,
          destinationPath,
        });
        downloadedPath = downloaded.destinationPath;
      } catch (err) {
        downloadFailure = failureReasonOf(err);
        deps.logger?.warn(
          "podcast download failed; keeping URL as canonical artifact",
          {
            editionId: input.editionId,
            partitionKey,
            podcastId: row.id,
            destinationPath,
            error: err instanceof Error ? err : new Error(String(err)),
          },
        );
      }

      const finalUpdate: Parameters<PodcastRepository["updateDelivery"]>[1] = {
        status: "ready",
        url: resolvedUrl,
        completedAt: new Date(),
        providerResponse: {
          phase: "ready",
          generation,
          download: {
            destinationPath,
            success: downloadedPath !== null,
            failureReason: downloadFailure,
          },
        },
      };
      if (downloadedPath !== null) {
        finalUpdate.localPath = downloadedPath;
      }
      if (downloadFailure !== null) {
        finalUpdate.failureReason = downloadFailure;
      }

      const updated = await deps.podcastRepo.updateDelivery(
        row.id,
        finalUpdate,
      );

      deps.logger?.info("podcast ready", {
        editionId: input.editionId,
        partitionKey,
        notebookId: notebook.id,
        podcastId: updated.id,
        artifactExternalId: updated.artifact_external_id,
        localPath: updated.local_path,
      });

      return rowToResult(updated, edition, {
        alreadyExisted: false,
        failureReason: updated.failure_reason,
      });
    } catch (err) {
      const reason = failureReasonOf(err);
      await ensureFailedRow({
        editionId: input.editionId,
        partitionKey,
        row,
        notebookId: notebook.id,
        reason,
      });
      throw err;
    }
  }

  return {
    async generateForDate({ editionDate, partitionKey, wait }) {
      const edition = await deps.editionRepo.getByDate(editionDate);
      if (!edition) {
        throw new Error(`no edition found for date ${String(editionDate)}`);
      }
      return generate({ editionId: edition.id, partitionKey, wait });
    },
    generate,
  };
}
