import { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface MarkdownDigestRow {
  id: string;
  edition_id: string;
  content: string;
  story_count: number;
  document_count: number;
  citation_count: number;
  created_at: Date;
}

export interface CreateMarkdownDigestInput {
  editionId: string;
  content: string;
  storyCount: number;
  documentCount: number;
  citationCount: number;
}

export interface MarkdownDigestRepository {
  createForEdition(input: CreateMarkdownDigestInput): Promise<MarkdownDigestRow>;
  getByEdition(editionId: string): Promise<MarkdownDigestRow | undefined>;
  deleteByEdition(editionId: string): Promise<void>;
}

export class MarkdownDigestConflictError extends Error {
  readonly editionId: string;
  constructor(editionId: string) {
    super(`markdown digest already exists for edition ${editionId}`);
    this.name = "MarkdownDigestConflictError";
    this.editionId = editionId;
  }
}

export function createMarkdownDigestRepository(
  db: Kysely<Database>,
): MarkdownDigestRepository {
  return {
    async createForEdition(input) {
      try {
        return await db
          .insertInto("markdown_digests")
          .values({
            edition_id: input.editionId,
            content: input.content,
            story_count: input.storyCount,
            document_count: input.documentCount,
            citation_count: input.citationCount,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new MarkdownDigestConflictError(input.editionId);
        }
        throw err;
      }
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("markdown_digests")
        .selectAll()
        .where("edition_id", "=", editionId)
        .executeTakeFirst();
    },

    async deleteByEdition(editionId) {
      await db
        .deleteFrom("markdown_digests")
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
