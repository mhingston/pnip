import { Kysely, type Transaction } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface EntityRow {
  id: string;
  chunk_id: string;
  document_id: string;
  name: string;
  entity_type: string;
  prompt_id: string;
  prompt_version: number;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface EntityMentionRow {
  id: string;
  entity_id: string;
  chunk_id: string;
  mention_text: string;
  created_at: Date;
}

export interface CreateEntitiesInput {
  chunkId: string;
  documentId: string;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  entities: { name: string; entityType: string; mentionText: string }[];
}

export interface CreateEntitiesResult {
  entities: EntityRow[];
  mentions: EntityMentionRow[];
}

export interface EntityRepository {
  replaceForChunk(
    input: CreateEntitiesInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<CreateEntitiesResult>;
  getByChunkId(chunkId: string): Promise<EntityRow[]>;
  getByDocumentId(documentId: string): Promise<EntityRow[]>;
  getMentionsByEntityId(entityId: string): Promise<EntityMentionRow[]>;
  deleteByChunkId(chunkId: string): Promise<void>;
}

export function createEntityRepository(db: Kysely<Database>): EntityRepository {
  return {
    async replaceForChunk(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        await trx.deleteFrom("entities").where("chunk_id", "=", input.chunkId).execute();

        const entityRows: EntityRow[] = [];
        const mentionRows: EntityMentionRow[] = [];

        for (const e of input.entities) {
          const entity = await trx
            .insertInto("entities")
            .values({
              chunk_id: input.chunkId,
              document_id: input.documentId,
              name: e.name,
              entity_type: e.entityType,
              prompt_id: input.promptId,
              prompt_version: input.promptVersion,
              model: input.model,
              provider: input.provider,
              input_hash: input.inputHash,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          entityRows.push(entity);

          const mention = await trx
            .insertInto("entity_mentions")
            .values({
              entity_id: entity.id,
              chunk_id: input.chunkId,
              mention_text: e.mentionText,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          mentionRows.push(mention);
        }

        return { entities: entityRows, mentions: mentionRows };
      });
    },

    async getByChunkId(chunkId) {
      return db
        .selectFrom("entities")
        .selectAll()
        .where("chunk_id", "=", chunkId)
        .orderBy("name", "asc")
        .execute();
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("entities")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async getMentionsByEntityId(entityId) {
      return db
        .selectFrom("entity_mentions")
        .selectAll()
        .where("entity_id", "=", entityId)
        .execute();
    },

    async deleteByChunkId(chunkId) {
      await db.deleteFrom("entities").where("chunk_id", "=", chunkId).execute();
    },
  };
}
