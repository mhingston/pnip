import { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface PodcastRow {
  id: string;
  edition_id: string;
  notebook_id: string;
  artifact_external_id: string;
  url: string | null;
  title: string | null;
  duration_seconds: number | null;
  format: string | null;
  language: string | null;
  status: string;
  local_path: string | null;
  provider_response: unknown | null;
  failure_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface CreatePodcastInput {
  editionId: string;
  notebookId: string;
  artifactExternalId: string;
  title?: string | null;
  format?: string | null;
  language?: string | null;
  status?: string;
  startedAt?: Date | null;
  failureReason?: string | null;
  providerResponse?: unknown;
}

export interface UpdatePodcastInput {
  status?: string;
  artifactExternalId?: string;
  url?: string | null;
  durationSeconds?: number | null;
  localPath?: string | null;
  providerResponse?: unknown;
  failureReason?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface PodcastRepository {
  createForEdition(input: CreatePodcastInput): Promise<PodcastRow>;
  getByEdition(editionId: string): Promise<PodcastRow | undefined>;
  getById(id: string): Promise<PodcastRow | undefined>;
  getByArtifactExternalId(
    artifactExternalId: string,
  ): Promise<PodcastRow | undefined>;
  updateDelivery(id: string, update: UpdatePodcastInput): Promise<PodcastRow>;
  deleteByEdition(editionId: string): Promise<void>;
}

export class PodcastConflictError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`podcast already exists for edition ${editionId}`);
    this.name = "PodcastConflictError";
    this.editionId = editionId;
  }
}

export function createPodcastRepository(
  db: Kysely<Database>,
): PodcastRepository {
  return {
    async createForEdition(input) {
      try {
        return await db
          .insertInto("podcasts")
          .values({
            edition_id: input.editionId,
            notebook_id: input.notebookId,
            artifact_external_id: input.artifactExternalId,
            url: null,
            title: input.title ?? null,
            duration_seconds: null,
            format: input.format ?? null,
            language: input.language ?? null,
            status: input.status ?? "pending",
            local_path: null,
            provider_response:
              input.providerResponse === undefined
                ? null
                : JSON.stringify(input.providerResponse),
            failure_reason: input.failureReason ?? null,
            started_at: input.startedAt ?? null,
            completed_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PodcastConflictError(input.editionId);
        }
        throw err;
      }
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("podcasts")
        .selectAll()
        .where("edition_id", "=", editionId)
        .executeTakeFirst();
    },

    async getById(id) {
      return db
        .selectFrom("podcasts")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByArtifactExternalId(artifactExternalId) {
      return db
        .selectFrom("podcasts")
        .selectAll()
        .where("artifact_external_id", "=", artifactExternalId)
        .executeTakeFirst();
    },

    async updateDelivery(id, update) {
      const setValues: {
        status?: string;
        artifact_external_id?: string;
        url?: string | null;
        duration_seconds?: number | null;
        local_path?: string | null;
        provider_response?: unknown;
        failure_reason?: string | null;
        started_at?: Date | null;
        completed_at?: Date | null;
      } = {};
      if (update.status !== undefined) setValues.status = update.status;
      if (update.artifactExternalId !== undefined) {
        setValues.artifact_external_id = update.artifactExternalId;
      }
      if (update.url !== undefined) setValues.url = update.url;
      if (update.durationSeconds !== undefined) {
        setValues.duration_seconds = update.durationSeconds;
      }
      if (update.localPath !== undefined) {
        setValues.local_path = update.localPath;
      }
      if (update.providerResponse !== undefined) {
        setValues.provider_response =
          update.providerResponse === null
            ? null
            : JSON.stringify(update.providerResponse);
      }
      if (update.failureReason !== undefined) {
        setValues.failure_reason = update.failureReason;
      }
      if (update.startedAt !== undefined) {
        setValues.started_at = update.startedAt;
      }
      if (update.completedAt !== undefined) {
        setValues.completed_at = update.completedAt;
      }
      const updated = await db
        .updateTable("podcasts")
        .set(setValues)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        throw new Error(`podcast row not found: ${id}`);
      }
      return updated;
    },

    async deleteByEdition(editionId) {
      await db
        .deleteFrom("podcasts")
        .where("edition_id", "=", editionId)
        .execute();
    },
  };
}

interface DatabaseErrorLike {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as DatabaseErrorLike;
  return e?.code === "23505";
}