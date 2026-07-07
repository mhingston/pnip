import { Kysely, type Transaction } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface QualityClassificationRow {
  id: string;
  chunk_id: string;
  document_id: string;
  label: string;
  confidence: number;
  reasoning: string | null;
  prompt_id: string;
  prompt_version: number;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface CreateQualityInput {
  chunkId: string;
  documentId: string;
  label: string;
  confidence: number;
  reasoning: string | null;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
}

export interface QualityRepository {
  replaceForChunk(
    input: CreateQualityInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<QualityClassificationRow>;
  getByChunkId(chunkId: string): Promise<QualityClassificationRow | undefined>;
  getByDocumentId(documentId: string): Promise<QualityClassificationRow[]>;
  deleteByChunkId(chunkId: string): Promise<void>;
}

export function createQualityRepository(db: Kysely<Database>): QualityRepository {
  return {
    async replaceForChunk(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("quality_classifications")
          .where("chunk_id", "=", input.chunkId)
          .execute();

        return trx
          .insertInto("quality_classifications")
          .values({
            chunk_id: input.chunkId,
            document_id: input.documentId,
            label: input.label,
            confidence: input.confidence,
            reasoning: input.reasoning,
            prompt_id: input.promptId,
            prompt_version: input.promptVersion,
            model: input.model,
            provider: input.provider,
            input_hash: input.inputHash,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    },

    async getByChunkId(chunkId) {
      return db
        .selectFrom("quality_classifications")
        .selectAll()
        .where("chunk_id", "=", chunkId)
        .executeTakeFirst();
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("quality_classifications")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async deleteByChunkId(chunkId) {
      await db
        .deleteFrom("quality_classifications")
        .where("chunk_id", "=", chunkId)
        .execute();
    },
  };
}
