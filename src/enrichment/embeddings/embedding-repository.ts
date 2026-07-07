import { Kysely, type Transaction } from "kysely";
import type { Database } from "../../database/kysely.js";
import { vectorToSql, sqlToVector } from "../../common/vector-codec.js";

export interface EmbeddingRow {
  id: string;
  chunk_id: string;
  vector: number[];
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface CreateEmbeddingInput {
  chunkId: string;
  vector: number[];
  model: string;
  provider: string;
  inputHash: string;
}

export interface EmbeddingRepository {
  replaceForChunk(
    input: CreateEmbeddingInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<EmbeddingRow>;
  getByChunkId(chunkId: string): Promise<EmbeddingRow | undefined>;
  getByDocumentId(documentId: string): Promise<EmbeddingRow[]>;
  deleteByChunkId(chunkId: string): Promise<void>;
}

interface RawEmbeddingRow {
  id: string;
  chunk_id: string;
  vector: string;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

function decode(row: RawEmbeddingRow): EmbeddingRow {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    vector: sqlToVector(row.vector),
    model: row.model,
    provider: row.provider,
    input_hash: row.input_hash,
    created_at: row.created_at,
  };
}

export function createEmbeddingRepository(db: Kysely<Database>): EmbeddingRepository {
  return {
    async replaceForChunk(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("embeddings")
          .where("chunk_id", "=", input.chunkId)
          .execute();

        const row = await trx
          .insertInto("embeddings")
          .values({
            chunk_id: input.chunkId,
            vector: vectorToSql(input.vector),
            model: input.model,
            provider: input.provider,
            input_hash: input.inputHash,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return decode(row as RawEmbeddingRow);
      });
    },

    async getByChunkId(chunkId) {
      const row = await db
        .selectFrom("embeddings")
        .selectAll()
        .where("chunk_id", "=", chunkId)
        .executeTakeFirst();
      return row ? decode(row as RawEmbeddingRow) : undefined;
    },

    async getByDocumentId(documentId) {
      const chunks = await db
        .selectFrom("document_chunks")
        .select("id")
        .where("document_id", "=", documentId)
        .execute();
      const ids = chunks.map((c) => c.id);
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom("embeddings")
        .selectAll()
        .where("chunk_id", "in", ids)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map((r) => decode(r as RawEmbeddingRow));
    },

    async deleteByChunkId(chunkId) {
      await db.deleteFrom("embeddings").where("chunk_id", "=", chunkId).execute();
    },
  };
}
