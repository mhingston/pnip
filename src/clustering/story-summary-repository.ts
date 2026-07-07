import { Kysely, type Transaction } from "kysely";
import type { Database } from "../database/kysely.js";

export interface StorySummaryRow {
  id: string;
  story_id: string;
  content: string;
  prompt_id: string;
  prompt_version: number;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface StorySummaryCitationRow {
  id: string;
  story_summary_id: string;
  chunk_id: string;
  claim_text: string;
  claim_order: number;
  created_at: Date;
}

export interface CreateStorySummaryInput {
  storyId: string;
  content: string;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  claims: { text: string; chunkId: string }[];
}

export interface CreateStorySummaryResult {
  summary: StorySummaryRow;
  citations: StorySummaryCitationRow[];
}

export interface StorySummaryRepository {
  replaceForStory(
    input: CreateStorySummaryInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<CreateStorySummaryResult>;
  getByStoryId(storyId: string): Promise<StorySummaryRow | undefined>;
  getCitationsBySummaryId(
    summaryId: string,
  ): Promise<StorySummaryCitationRow[]>;
  deleteByStoryId(storyId: string): Promise<void>;
}

export function createStorySummaryRepository(
  db: Kysely<Database>,
): StorySummaryRepository {
  return {
    async replaceForStory(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        if (input.claims.length === 0) {
          throw new Error("story summary must have at least one claim");
        }

        await trx
          .deleteFrom("story_summaries")
          .where("story_id", "=", input.storyId)
          .execute();

        const summary = await trx
          .insertInto("story_summaries")
          .values({
            story_id: input.storyId,
            content: input.content,
            prompt_id: input.promptId,
            prompt_version: input.promptVersion,
            model: input.model,
            provider: input.provider,
            input_hash: input.inputHash,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const inserted: StorySummaryCitationRow[] = [];
        for (let i = 0; i < input.claims.length; i++) {
          const claim = input.claims[i];
          const row = await trx
            .insertInto("story_summary_citations")
            .values({
              story_summary_id: summary.id,
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

    async getByStoryId(storyId) {
      return db
        .selectFrom("story_summaries")
        .selectAll()
        .where("story_id", "=", storyId)
        .executeTakeFirst();
    },

    async getCitationsBySummaryId(summaryId) {
      return db
        .selectFrom("story_summary_citations")
        .selectAll()
        .where("story_summary_id", "=", summaryId)
        .orderBy("claim_order", "asc")
        .execute();
    },

    async deleteByStoryId(storyId) {
      await db
        .deleteFrom("story_summaries")
        .where("story_id", "=", storyId)
        .execute();
    },
  };
}
