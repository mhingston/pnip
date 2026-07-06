import { Kysely, sql, type SqlBool } from "kysely";
import type { Database, PromptVersion } from "../database/kysely.js";

export class PromptVersionConflictError extends Error {
  readonly promptName: string;
  readonly version: number;
  constructor(promptName: string, version: number) {
    super(`Prompt version conflict: ${promptName}@v${version}`);
    this.name = "PromptVersionConflictError";
    this.promptName = promptName;
    this.version = version;
  }
}

export interface PromptRepository {
  create(input: {
    name: string;
    version: number;
    template: string;
    purpose: string;
  }): Promise<PromptVersion>;
  getById(id: string): Promise<PromptVersion | undefined>;
  getByNameAndVersion(
    name: string,
    version: number,
  ): Promise<PromptVersion | undefined>;
  getLatestVersion(name: string): Promise<PromptVersion | undefined>;
  createNewVersion(input: {
    name: string;
    template: string;
    purpose: string;
  }): Promise<PromptVersion>;
  listByName(name: string): Promise<PromptVersion[]>;
}

export function createPromptRepository(db: Kysely<Database>): PromptRepository {
  return {
    async create(input): Promise<PromptVersion> {
      try {
        return await db
          .insertInto("prompt_versions")
          .values({
            name: input.name,
            version: input.version,
            template: input.template,
            purpose: input.purpose,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PromptVersionConflictError(input.name, input.version);
        }
        throw err;
      }
    },

    async getById(id: string): Promise<PromptVersion | undefined> {
      return db
        .selectFrom("prompt_versions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByNameAndVersion(
      name: string,
      version: number,
    ): Promise<PromptVersion | undefined> {
      return db
        .selectFrom("prompt_versions")
        .selectAll()
        .where("name", "=", name)
        .where("version", "=", version)
        .executeTakeFirst();
    },

    async getLatestVersion(name: string): Promise<PromptVersion | undefined> {
      return db
        .selectFrom("prompt_versions")
        .selectAll()
        .where("name", "=", name)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
    },

    async createNewVersion(input): Promise<PromptVersion> {
      return db.transaction().execute(async (trx) => {
        const latest = await trx
          .selectFrom("prompt_versions")
          .selectAll()
          .where("name", "=", input.name)
          .orderBy("version", "desc")
          .limit(1)
          .forUpdate()
          .executeTakeFirst();
        const nextVersion = (latest?.version ?? 0) + 1;
        return trx
          .insertInto("prompt_versions")
          .values({
            name: input.name,
            version: nextVersion,
            template: input.template,
            purpose: input.purpose,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    },

    async listByName(name: string): Promise<PromptVersion[]> {
      return db
        .selectFrom("prompt_versions")
        .selectAll()
        .where("name", "=", name)
        .orderBy("version", "desc")
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
