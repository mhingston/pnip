import { Kysely, type Transaction } from "kysely";
import type { Database } from "../../database/kysely.js";

export interface TopicRow {
  id: string;
  chunk_id: string;
  document_id: string;
  topic: string;
  confidence: number;
  prompt_id: string;
  prompt_version: number;
  model: string;
  provider: string;
  input_hash: string;
  created_at: Date;
}

export interface TopicAssignmentRow {
  id: string;
  topic_id: string;
  chunk_id: string;
  relevance: number;
  created_at: Date;
}

export interface CreateTopicsInput {
  chunkId: string;
  documentId: string;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  topics: { topic: string; confidence: number; relevance: number }[];
}

export interface CreateTopicsResult {
  topics: TopicRow[];
  assignments: TopicAssignmentRow[];
}

export interface TopicRepository {
  replaceForChunk(
    input: CreateTopicsInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<CreateTopicsResult>;
  getByChunkId(chunkId: string): Promise<TopicRow[]>;
  getByDocumentId(documentId: string): Promise<TopicRow[]>;
  getAssignmentsByTopicId(topicId: string): Promise<TopicAssignmentRow[]>;
  deleteByChunkId(chunkId: string): Promise<void>;
}

export function createTopicRepository(db: Kysely<Database>): TopicRepository {
  return {
    async replaceForChunk(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        await trx.deleteFrom("topics").where("chunk_id", "=", input.chunkId).execute();

        const topicRows: TopicRow[] = [];
        const assignmentRows: TopicAssignmentRow[] = [];

        for (const t of input.topics) {
          const topic = await trx
            .insertInto("topics")
            .values({
              chunk_id: input.chunkId,
              document_id: input.documentId,
              topic: t.topic,
              confidence: t.confidence,
              prompt_id: input.promptId,
              prompt_version: input.promptVersion,
              model: input.model,
              provider: input.provider,
              input_hash: input.inputHash,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          topicRows.push(topic);

          const assignment = await trx
            .insertInto("topic_assignments")
            .values({
              topic_id: topic.id,
              chunk_id: input.chunkId,
              relevance: t.relevance,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          assignmentRows.push(assignment);
        }

        return { topics: topicRows, assignments: assignmentRows };
      });
    },

    async getByChunkId(chunkId) {
      return db
        .selectFrom("topics")
        .selectAll()
        .where("chunk_id", "=", chunkId)
        .orderBy("confidence", "desc")
        .execute();
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("topics")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async getAssignmentsByTopicId(topicId) {
      return db
        .selectFrom("topic_assignments")
        .selectAll()
        .where("topic_id", "=", topicId)
        .execute();
    },

    async deleteByChunkId(chunkId) {
      await db.deleteFrom("topics").where("chunk_id", "=", chunkId).execute();
    },
  };
}
