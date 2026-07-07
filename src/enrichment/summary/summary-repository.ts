import { Kysely, type Transaction } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface SummaryRow {
  id: string;
  chunk_id: string;
  document_id: string;
  content: string;
  prompt_id: string;
  prompt_version: number;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface SummaryCitationRow {
  id: string;
  summary_id: string;
  chunk_id: string;
  claim_text: string;
  claim_order: number;
  created_at: Date;
}

export interface CreateSummaryInput {
  chunkId: string;
  documentId: string;
  content: string;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  claims: { text: string; chunkId: string }[];
}

export interface CreateSummaryResult {
  summary: SummaryRow;
  citations: SummaryCitationRow[];
}

export interface SummaryRepository {
  replaceForChunk(
    input: CreateSummaryInput,
    db?: Kysely<Database> | Transaction<Database>,
  ): Promise<CreateSummaryResult>;
  getByChunkId(chunkId: string): Promise<SummaryRow | undefined>;
  getByDocumentId(documentId: string): Promise<SummaryRow[]>;
  getCitationsBySummaryId(summaryId: string): Promise<SummaryCitationRow[]>;
  deleteByChunkId(chunkId: string): Promise<void>;
}

export function createSummaryRepository(db: Kysely<Database>): SummaryRepository {
  return {
    async replaceForChunk(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        const citations = input.claims;
        if (citations.length === 0) {
          throw new Error("summary must have at least one claim");
        }

        await trx.deleteFrom("summaries").where("chunk_id", "=", input.chunkId).execute();

        const summary = await trx
          .insertInto("summaries")
          .values({
            chunk_id: input.chunkId,
            document_id: input.documentId,
            content: input.content,
            prompt_id: input.promptId,
            prompt_version: input.promptVersion,
            model: input.model,
            provider: input.provider,
            input_hash: input.inputHash,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const inserted: SummaryCitationRow[] = [];
        for (let i = 0; i < citations.length; i++) {
          const claim = citations[i];
          const row = await trx
            .insertInto("summary_citations")
            .values({
              summary_id: summary.id,
              chunk_id: claim.chunkId,
              claim_text: claim.text,
              claim_order: i,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          inserted.push(row);
        }

        return { summary, citations: inserted };
      });
    },

    async getByChunkId(chunkId) {
      const row = await db
        .selectFrom("summaries")
        .selectAll()
        .where("chunk_id", "=", chunkId)
        .executeTakeFirst();
      return row;
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("summaries")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async getCitationsBySummaryId(summaryId) {
      return db
        .selectFrom("summary_citations")
        .selectAll()
        .where("summary_id", "=", summaryId)
        .orderBy("claim_order", "asc")
        .execute();
    },

    async deleteByChunkId(chunkId) {
      await db.deleteFrom("summaries").where("chunk_id", "=", chunkId).execute();
    },
  };
}
