import type { Logger } from "../../logging/logger.js";
import type { Kysely } from "kysely";
import type { Database, Edition } from "../../database/kysely.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type {
  MarkdownDigestRepository,
  MarkdownDigestRow,
} from "../markdown/markdown-digest-repository.js";
import type { DocumentRepository } from "../../expansion/document-repository.js";
import type {
  NotebookRepository,
  NotebookRow,
} from "./notebook-repository.js";
import { NotebookConflictError } from "./notebook-repository.js";
import type {
  AddSourceInput,
  CreateNotebookResult,
  NotebookLmClient,
} from "./notebooklm-client.js";
import { NotebookLmError } from "./notebooklm-client.js";
import type {
  CreateSignalInput,
  SignalRepository,
} from "../../signals/signal-repository.js";

export interface NotebookServiceConfig {
  sourceWaitTimeoutSec?: number;
  sourcePollIntervalMs?: number;
  titleTemplate?: (publicationDate: string, partitionKey: string) => string;
  partitionMinArticles?: number;
  maxSourcesPerNotebook?: number;
}

export interface NotebookServiceDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  markdownDigestRepo: MarkdownDigestRepository;
  docRepo: DocumentRepository;
  notebookRepo: NotebookRepository;
  notebookLm: NotebookLmClient;
  signalRepo?: SignalRepository;
  config?: NotebookServiceConfig;
  logger?: Logger;
}

export interface NotebookServiceResult {
  notebookId: string;
  edition: Edition;
  notebookExternalId: string;
  url: string;
  sourceCount: number;
  status: "ready" | "pending" | "failed" | "skipped";
  alreadyExisted: boolean;
  failureReason: string | null;
  skipReason: string | null;
  mode: "wait" | "fire-and-forget";
  partitionKey: string;
}

export interface GenerateNotebookInput {
  editionId: string;
  partitionKey?: string;
  wait?: boolean;
}

export interface NotebookService {
  generate(input: GenerateNotebookInput): Promise<NotebookServiceResult>;
  generateForDate(input: {
    editionDate: string | Date;
    partitionKey?: string;
    wait?: boolean;
  }): Promise<NotebookServiceResult>;
}

export interface UploadedSource {
  sourceExternalId: string;
  docId: string | null;
  displayName: string;
}

export interface NotebookProviderState {
  phase: "pending" | "ready" | "failed";
  createNotebook?: CreateNotebookResult;
  uploadedSources?: UploadedSource[];
  error?: string;
}

const DEFAULT_PARTITION_MIN_ARTICLES = 5;
const DEFAULT_PARTITION_KEY = "master";
const DEFAULT_MAX_SOURCES_PER_NOTEBOOK = 50;
const PENDING_NOTEBOOK_PLACEHOLDER = "pending";
const PENDING_NOTEBOOK_URL =
  "https://notebooklm.google.com/notebook/pending";

function formatPublicationDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rowToResult(
  row: NotebookRow,
  edition: Edition,
  options: {
    alreadyExisted: boolean;
    mode: "wait" | "fire-and-forget";
  },
): NotebookServiceResult {
  const state = parseProviderState(row.provider_response);
  return {
    notebookId: row.id,
    edition,
    notebookExternalId: row.notebook_external_id,
    url: row.url,
    sourceCount: row.source_count,
    status: row.status as "ready" | "pending" | "failed" | "skipped",
    alreadyExisted: options.alreadyExisted,
    failureReason: state?.error ?? null,
    skipReason: null,
    mode: options.mode,
    partitionKey: row.partition_key,
  };
}

function localPathFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const candidate = (metadata as { local_path?: unknown }).local_path;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function failureReasonOf(err: unknown): string {
  if (err instanceof NotebookLmError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseProviderState(raw: unknown): NotebookProviderState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<NotebookProviderState> & {
    uploaded_sources?: Array<{
      source_external_id?: unknown;
      doc_id?: unknown;
      display_name?: unknown;
    }>;
  };
  if (!r.createNotebook) return null;
  const uploaded = Array.isArray(r.uploadedSources)
    ? r.uploadedSources
    : Array.isArray(r.uploaded_sources)
      ? r.uploaded_sources.map((s) => ({
          sourceExternalId:
            typeof s.source_external_id === "string"
              ? s.source_external_id
              : "",
          docId: typeof s.doc_id === "string" ? s.doc_id : null,
          displayName:
            typeof s.display_name === "string"
              ? s.display_name
              : "Untitled",
        }))
      : [];
  return {
    phase: r.phase ?? "pending",
    createNotebook: r.createNotebook as CreateNotebookResult,
    uploadedSources: uploaded,
    error: r.error,
  };
}

async function writeNotebookExcludedSignals(
  signalRepo: SignalRepository,
  logger: Logger | undefined,
  editionId: string,
  partitionKey: string,
  cap: number,
  excludedDocs: {
    id: string;
    source_url: string;
    canonical_url: string | null;
  }[],
): Promise<void> {
  const totalDocuments = excludedDocs.length + cap;
  const signalInputs: CreateSignalInput[] = excludedDocs.map((doc, idx) => ({
    signal_kind: "notebook_excluded",
    edition_id: editionId,
    document_id: doc.id,
    source_url: doc.canonical_url ?? doc.source_url,
    payload: {
      partition_key: partitionKey,
      reason: "source_cap",
      cap,
      total_documents: totalDocuments,
      rank: cap + idx + 1,
    },
  }));
  try {
    await signalRepo.createBatch(signalInputs);
  } catch (err) {
    logger?.warn("failed to insert notebook_excluded signals", {
      editionId,
      partitionKey,
      excludedCount: excludedDocs.length,
      error: err as Error,
    });
  }
}

async function tryCreateForEdition(
  deps: { notebookRepo: NotebookRepository },
  input: {
    editionId: string;
    partitionKey: string;
    title: string;
  },
): Promise<{ row: NotebookRow; created: boolean }> {
  try {
    const row = await deps.notebookRepo.createForEdition({
      editionId: input.editionId,
      partitionKey: input.partitionKey,
      notebookExternalId: PENDING_NOTEBOOK_PLACEHOLDER,
      title: input.title,
      url: PENDING_NOTEBOOK_URL,
      status: "pending",
      sourceCount: 0,
      providerResponse: {
        phase: "pending",
      } satisfies NotebookProviderState,
    });
    return { row, created: true };
  } catch (err) {
    if (err instanceof NotebookConflictError) {
      const existing = await deps.notebookRepo.getByEditionAndPartition(
        input.editionId,
        input.partitionKey,
      );
      if (existing) return { row: existing, created: false };
    }
    throw err;
  }
}

export function createNotebookService(
  deps: NotebookServiceDeps,
): NotebookService {
  function resolveEdition(editionId: string): Promise<Edition> {
    return deps.editionRepo.getById(editionId).then((ed) => {
      if (!ed) throw new Error(`edition not found: ${editionId}`);
      return ed;
    });
  }

  async function markFailed(input: {
    row: NotebookRow | null;
    createdResult: CreateNotebookResult | null;
    editionId: string;
    partitionKey: string;
    reason: string;
  }): Promise<void> {
    if (input.row) {
      await deps.notebookRepo.updateDelivery(input.row.id, {
        status: "failed",
        completedAt: new Date(),
        providerResponse: {
          phase: "failed",
          error: input.reason,
          createNotebook: input.createdResult ?? undefined,
        } satisfies NotebookProviderState,
      });
      return;
    }
    try {
      await deps.notebookRepo.createForEdition({
        editionId: input.editionId,
        partitionKey: input.partitionKey,
        notebookExternalId:
          input.createdResult?.notebookExternalId ?? "unknown",
        title: input.createdResult?.title ?? "Unknown",
        url:
          input.createdResult?.url ??
          "https://notebooklm.google.com/notebook/unknown",
        status: "failed",
        sourceCount: 0,
        providerResponse: {
          phase: "failed",
          error: input.reason,
        } satisfies NotebookProviderState,
      });
    } catch (err) {
      if (err instanceof NotebookConflictError) {
        const after = await deps.notebookRepo.getByEditionAndPartition(
          input.editionId,
          input.partitionKey,
        );
        if (after) {
          await deps.notebookRepo.updateDelivery(after.id, {
            status: "failed",
            completedAt: new Date(),
            providerResponse: {
              phase: "failed",
              error: input.reason,
            } satisfies NotebookProviderState,
          });
        }
        return;
      }
      throw err;
    }
  }

  async function createAndUpload(input: {
    editionId: string;
    partitionKey: string;
  }): Promise<{
    row: NotebookRow;
    createNotebook: CreateNotebookResult | null;
    uploadedSources: UploadedSource[];
    recovered: boolean;
  }> {
    const markdown: MarkdownDigestRow | undefined =
      await deps.markdownDigestRepo.getByEdition(input.editionId);
    if (!markdown) {
      throw new Error(
        `no markdown digest found for edition ${input.editionId}; ` +
          `run "digestive generate-digest --date ${formatPublicationDate((await deps.editionRepo.getById(input.editionId))!.publication_date)}" first`,
      );
    }

    const maxSources =
      deps.config?.maxSourcesPerNotebook ?? DEFAULT_MAX_SOURCES_PER_NOTEBOOK;
    const ranked = await deps.docRepo.getRankedByEditionAndPartition(
      input.editionId,
      input.partitionKey,
      maxSources,
    );
    const documents = ranked.kept;
    const uploadableDocs = documents.filter(
      (d) =>
        (d.canonical_url !== null && d.canonical_url.length > 0) ||
        (d.source_url !== null && d.source_url.length > 0),
    );
    if (uploadableDocs.length === 0) {
      throw new Error(
        `edition ${input.editionId} partition '${input.partitionKey}' has no curated source documents with uploadable URLs`,
      );
    }

    const edition = await deps.editionRepo.getById(input.editionId);
    if (!edition) throw new Error(`edition not found: ${input.editionId}`);
    const publicationDate = formatPublicationDate(edition.publication_date);
    const title = deps.config?.titleTemplate
      ? deps.config.titleTemplate(publicationDate, input.partitionKey)
      : input.partitionKey === "master"
        ? `Daily Digest — ${publicationDate}`
        : `Daily Digest — ${publicationDate} — ${formatPartitionTitle(input.partitionKey)}`;

    const inserted = await tryCreateForEdition(deps, {
      editionId: input.editionId,
      partitionKey: input.partitionKey,
      title,
    });

    if (!inserted.created) {
      const recoveredState = parseProviderState(inserted.row.provider_response);
      return {
        row: inserted.row,
        createNotebook: recoveredState?.createNotebook ?? null,
        uploadedSources: recoveredState?.uploadedSources ?? [],
        recovered: true,
      };
    }

    const createNotebook = await deps.notebookLm.createNotebook({ title });

    let row = await deps.notebookRepo.updateDelivery(inserted.row.id, {
      notebookExternalId: createNotebook.notebookExternalId,
      title: createNotebook.title,
      url: createNotebook.url,
      status: "pending",
      sourceCount: 0,
      providerResponse: {
        phase: "pending",
        createNotebook,
        uploadedSources: [],
      } satisfies NotebookProviderState,
    });

    const uploadedSources: UploadedSource[] = [];
    for (const doc of uploadableDocs) {
      const localPath =
        doc.source_type === "pdf"
          ? localPathFromMetadata(doc.metadata)
          : undefined;
      const url = doc.canonical_url ?? doc.source_url;
      if (!url && !localPath) continue;
      const sourceInput: AddSourceInput = localPath
        ? {
            notebookExternalId: createNotebook.notebookExternalId,
            filePath: localPath,
            displayName: doc.title ?? "Untitled",
          }
        : {
            notebookExternalId: createNotebook.notebookExternalId,
            url,
            displayName: doc.title ?? "Untitled",
          };
      const src = await deps.notebookLm.addSource(sourceInput);
      uploadedSources.push({
        sourceExternalId: src.sourceExternalId,
        docId: doc.id,
        displayName: doc.title ?? "Untitled",
      });
    }

    const digestSource = await deps.notebookLm.addSource({
      notebookExternalId: createNotebook.notebookExternalId,
      markdownContent: markdown.content,
      displayName: `Daily Digest ${publicationDate}`,
    });
    uploadedSources.push({
      sourceExternalId: digestSource.sourceExternalId,
      docId: null,
      displayName: `Daily Digest ${publicationDate}`,
    });

    if (ranked.excluded.length > 0 && deps.signalRepo) {
      await writeNotebookExcludedSignals(
        deps.signalRepo,
        deps.logger,
        input.editionId,
        input.partitionKey,
        maxSources,
        ranked.excluded,
      );
    }

    row = await deps.notebookRepo.updateDelivery(row.id, {
      sourceCount: uploadedSources.length,
      providerResponse: {
        phase: "pending",
        createNotebook,
        uploadedSources,
      } satisfies NotebookProviderState,
    });

    return { row, createNotebook, uploadedSources, recovered: false };
  }

  async function pollUntilReady(input: {
    row: NotebookRow;
    uploadedSources: UploadedSource[];
  }): Promise<NotebookRow> {
    if (
      input.uploadedSources.length === 0 &&
      input.row.status === "pending"
    ) {
      deps.logger?.info(
        "notebook has no uploaded sources yet; deferring poll",
        {
          editionId: input.row.edition_id,
          notebookId: input.row.id,
        },
      );
      return input.row;
    }
    for (const src of input.uploadedSources) {
      const waited = await deps.notebookLm.waitForSource({
        notebookExternalId: input.row.notebook_external_id,
        sourceExternalId: src.sourceExternalId,
        timeoutSec: deps.config?.sourceWaitTimeoutSec,
        pollIntervalMs: deps.config?.sourcePollIntervalMs,
      });
      if (waited.status === "error") {
        const reason = `source "${src.displayName}" (${src.sourceExternalId}) failed to ingest`;
        deps.logger?.error("notebook source failed", {
          editionId: input.row.edition_id,
          notebookId: input.row.id,
          sourceExternalId: src.sourceExternalId,
          displayName: src.displayName,
        });
        return deps.notebookRepo.updateDelivery(input.row.id, {
          status: "failed",
          sourceCount: input.row.source_count || input.uploadedSources.length,
          completedAt: new Date(),
          providerResponse: {
            phase: "failed",
            error: reason,
            createNotebook: parseProviderState(input.row.provider_response)
              ?.createNotebook,
            uploadedSources: input.uploadedSources,
          } satisfies NotebookProviderState,
        });
      }
      if (waited.status === "timeout") {
        const reason = `source "${src.displayName}" (${src.sourceExternalId}) did not finish ingesting within the timeout`;
        deps.logger?.error("notebook source timed out", {
          editionId: input.row.edition_id,
          notebookId: input.row.id,
          sourceExternalId: src.sourceExternalId,
          displayName: src.displayName,
        });
        return deps.notebookRepo.updateDelivery(input.row.id, {
          status: "failed",
          sourceCount: input.row.source_count || input.uploadedSources.length,
          completedAt: new Date(),
          providerResponse: {
            phase: "failed",
            error: reason,
            createNotebook: parseProviderState(input.row.provider_response)
              ?.createNotebook,
            uploadedSources: input.uploadedSources,
          } satisfies NotebookProviderState,
        });
      }
    }

    return deps.notebookRepo.updateDelivery(input.row.id, {
      status: "ready",
      sourceCount: input.row.source_count || input.uploadedSources.length,
      completedAt: new Date(),
      providerResponse: {
        phase: "ready",
        createNotebook: parseProviderState(input.row.provider_response)
          ?.createNotebook,
        uploadedSources: input.uploadedSources,
      } satisfies NotebookProviderState,
    });
  }

  async function generate(
    input: GenerateNotebookInput,
  ): Promise<NotebookServiceResult> {
    const partitionKey = input.partitionKey ?? DEFAULT_PARTITION_KEY;
    const minArticles =
      deps.config?.partitionMinArticles ?? DEFAULT_PARTITION_MIN_ARTICLES;
    const edition = await resolveEdition(input.editionId);
    const wait = input.wait ?? false;
    const mode: "wait" | "fire-and-forget" = wait ? "wait" : "fire-and-forget";

    const existing = await deps.notebookRepo.getByEditionAndPartition(
      input.editionId,
      partitionKey,
    );
    if (existing && existing.status === "ready") {
      deps.logger?.info(
        "notebook already ready for edition; idempotent return",
        { editionId: input.editionId, partitionKey, notebookId: existing.id },
      );
      return rowToResult(existing, edition, { alreadyExisted: true, mode });
    }

    if (
      existing &&
      existing.status === "pending" &&
      !wait &&
      existing.notebook_external_id !== PENDING_NOTEBOOK_PLACEHOLDER
    ) {
      deps.logger?.info(
        "notebook already pending for edition; fire-and-forget no-op",
        { editionId: input.editionId, partitionKey, notebookId: existing.id },
      );
      return rowToResult(existing, edition, { alreadyExisted: true, mode });
    }

    if (
      existing &&
      existing.status === "pending" &&
      existing.notebook_external_id === PENDING_NOTEBOOK_PLACEHOLDER
    ) {
      deps.logger?.warn(
        "found stale placeholder notebook row; deleting and retrying from scratch",
        {
          editionId: input.editionId,
          partitionKey,
          notebookId: existing.id,
        },
      );
      await deps.notebookRepo.deleteByEditionAndPartition(
        input.editionId,
        partitionKey,
      );
    }

    const refreshed =
      existing &&
      existing.status === "pending" &&
      existing.notebook_external_id === PENDING_NOTEBOOK_PLACEHOLDER
        ? undefined
        : existing;

    let created: {
      row: NotebookRow;
      createNotebook: CreateNotebookResult | null;
      uploadedSources: UploadedSource[];
      recovered: boolean;
    };

    try {
      if (
        refreshed &&
        refreshed.status === "pending" &&
        wait &&
        refreshed.notebook_external_id !== PENDING_NOTEBOOK_PLACEHOLDER
      ) {
        const state = parseProviderState(refreshed.provider_response);
        if (!state || !state.createNotebook || !state.uploadedSources) {
          throw new Error(
            `notebook row for edition ${input.editionId} partition '${partitionKey}' is in 'pending' state but has no provider_response with uploaded sources; delete the row and re-run`,
          );
        }
        created = {
          row: refreshed,
          createNotebook: state.createNotebook,
          uploadedSources: state.uploadedSources,
          recovered: true,
        };
      } else {
        if (refreshed && refreshed.status === "failed") {
          await deps.notebookRepo.deleteByEditionAndPartition(
            input.editionId,
            partitionKey,
          );
        }
        const documents = await deps.docRepo.getByEditionAndPartition(
          input.editionId,
          partitionKey,
        );
        const uploadableDocs = documents.filter(
          (d) =>
            (d.canonical_url !== null && d.canonical_url.length > 0) ||
            (d.source_url !== null && d.source_url.length > 0),
        );
        const shouldSkip =
          partitionKey !== DEFAULT_PARTITION_KEY &&
          documents.length < minArticles;
        if (shouldSkip) {
          deps.logger?.info("notebook generation skipped", {
            editionId: input.editionId,
            partitionKey,
            documentCount: documents.length,
            minArticles,
          });
          return {
            notebookId: "",
            edition,
            notebookExternalId: "",
            url: "",
            sourceCount: documents.length,
            status: "skipped",
            alreadyExisted: false,
            failureReason: null,
            skipReason: `partition '${partitionKey}' has ${documents.length} documents, below threshold ${minArticles}`,
            mode,
            partitionKey,
          };
        }
        created = await createAndUpload({
          editionId: input.editionId,
          partitionKey,
        });
      }
    } catch (err) {
      const reason = failureReasonOf(err);
      await markFailed({
        row: refreshed ?? null,
        createdResult: null,
        editionId: input.editionId,
        partitionKey,
        reason,
      });
      throw err;
    }

    if (!wait) {
      deps.logger?.info("notebook sources uploaded; fire-and-forget", {
        editionId: input.editionId,
        partitionKey,
        notebookId: created.row.id,
        sourceCount: created.uploadedSources.length,
        recovered: created.recovered,
      });
      return rowToResult(created.row, edition, {
        alreadyExisted: created.recovered,
        mode,
      });
    }

    const updated = await pollUntilReady({
      row: created.row,
      uploadedSources: created.uploadedSources,
    });

    deps.logger?.info("notebook ready", {
      editionId: input.editionId,
      partitionKey,
      notebookId: updated.id,
      sourceCount: updated.source_count,
      recovered: created.recovered,
    });

    return rowToResult(updated, edition, {
      alreadyExisted: created.recovered,
      mode,
    });
  }

  return {
    async generateForDate({ editionDate, partitionKey, wait }) {
      const edition = await deps.editionRepo.getByDate(editionDate);
      if (!edition) {
        throw new Error(`no edition found for date ${String(editionDate)}`);
      }
      return generate({
        editionId: edition.id,
        partitionKey,
        wait,
      });
    },
    generate,
  };
}

function formatPartitionTitle(partitionKey: string): string {
  if (partitionKey.toLowerCase() === "youtube") return "YouTube";
  return partitionKey
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
