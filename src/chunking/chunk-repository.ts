import { Kysely, sql } from "kysely";
import type { Database } from "../database/kysely.js";

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  section_id: string;
  chunk_sequence: number;
  content_text: string;
  token_count: number;
  start_offset: number;
  end_offset: number;
  paragraph_start: number;
  paragraph_end: number;
  timestamp_start: number | null;
  timestamp_end: number | null;
  created_at: Date;
}

export interface CreateChunkInput {
  id: string;
  documentId: string;
  sectionId: string;
  sequence: number;
  text: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  paragraphStart: number;
  paragraphEnd: number;
  timestampStart?: number;
  timestampEnd?: number;
}

export interface ChunkRepository {
  createBatch(inputs: CreateChunkInput[]): Promise<DocumentChunkRow[]>;
  getByDocumentId(documentId: string): Promise<DocumentChunkRow[]>;
  getBySectionId(sectionId: string): Promise<DocumentChunkRow[]>;
  getByDocumentIdOrdered(documentId: string): Promise<DocumentChunkRow[]>;
  deleteByDocumentId(documentId: string): Promise<void>;
}

export function createChunkRepository(db: Kysely<Database>): ChunkRepository {
  return {
    async createBatch(inputs) {
      if (inputs.length === 0) return [];
      return db
        .insertInto("document_chunks")
        .values(
          inputs.map((i) => ({
            id: i.id,
            document_id: i.documentId,
            section_id: i.sectionId,
            chunk_sequence: i.sequence,
            content_text: i.text,
            token_count: i.tokenCount,
            start_offset: i.startOffset,
            end_offset: i.endOffset,
            paragraph_start: i.paragraphStart,
            paragraph_end: i.paragraphEnd,
            timestamp_start: i.timestampStart ?? null,
            timestamp_end: i.timestampEnd ?? null,
          })),
        )
        .returningAll()
        .execute();
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("document_chunks")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("chunk_sequence", "asc")
        .execute();
    },

    async getBySectionId(sectionId) {
      return db
        .selectFrom("document_chunks")
        .selectAll()
        .where("section_id", "=", sectionId)
        .orderBy("chunk_sequence", "asc")
        .execute();
    },

    async getByDocumentIdOrdered(documentId) {
      return db
        .selectFrom("document_chunks")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy(["section_id", "chunk_sequence"])
        .execute();
    },

    async deleteByDocumentId(documentId) {
      await db
        .deleteFrom("document_chunks")
        .where("document_id", "=", documentId)
        .execute();
    },
  };
}
