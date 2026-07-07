import { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface NotebookRow {
  id: string;
  edition_id: string;
  notebook_external_id: string;
  title: string;
  url: string;
  source_count: number;
  status: string;
  provider_response: unknown | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CreateNotebookInput {
  editionId: string;
  notebookExternalId: string;
  title: string;
  url: string;
  sourceCount?: number;
  status?: string;
  providerResponse?: unknown;
}

export interface UpdateNotebookInput {
  status?: string;
  sourceCount?: number;
  providerResponse?: unknown;
  completedAt?: Date | null;
}

export interface NotebookRepository {
  createForEdition(input: CreateNotebookInput): Promise<NotebookRow>;
  getByEdition(editionId: string): Promise<NotebookRow | undefined>;
  getById(id: string): Promise<NotebookRow | undefined>;
  getByExternalId(externalId: string): Promise<NotebookRow | undefined>;
  updateDelivery(id: string, update: UpdateNotebookInput): Promise<NotebookRow>;
  deleteByEdition(editionId: string): Promise<void>;
}

export class NotebookConflictError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`notebook already exists for edition ${editionId}`);
    this.name = "NotebookConflictError";
    this.editionId = editionId;
  }
}

export function createNotebookRepository(
  db: Kysely<Database>,
): NotebookRepository {
  return {
    async createForEdition(input) {
      try {
        return await db
          .insertInto("notebooks")
          .values({
            edition_id: input.editionId,
            notebook_external_id: input.notebookExternalId,
            title: input.title,
            url: input.url,
            source_count: input.sourceCount ?? 0,
            status: input.status ?? "pending",
            provider_response:
              input.providerResponse === undefined
                ? null
                : JSON.stringify(input.providerResponse),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new NotebookConflictError(input.editionId);
        }
        throw err;
      }
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("notebooks")
        .selectAll()
        .where("edition_id", "=", editionId)
        .executeTakeFirst();
    },

    async getById(id) {
      return db
        .selectFrom("notebooks")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByExternalId(externalId) {
      return db
        .selectFrom("notebooks")
        .selectAll()
        .where("notebook_external_id", "=", externalId)
        .executeTakeFirst();
    },

    async updateDelivery(id, update) {
      const setValues: {
        status?: string;
        source_count?: number;
        provider_response?: unknown;
        completed_at?: Date | null;
      } = {};
      if (update.status !== undefined) setValues.status = update.status;
      if (update.sourceCount !== undefined) {
        setValues.source_count = update.sourceCount;
      }
      if (update.providerResponse !== undefined) {
        setValues.provider_response =
          update.providerResponse === null
            ? null
            : JSON.stringify(update.providerResponse);
      }
      if (update.completedAt !== undefined) {
        setValues.completed_at = update.completedAt;
      }
      const updated = await db
        .updateTable("notebooks")
        .set(setValues)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        throw new Error(`notebook row not found: ${id}`);
      }
      return updated;
    },

    async deleteByEdition(editionId) {
      await db
        .deleteFrom("notebooks")
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