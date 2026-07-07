import { Kysely, sql } from "kysely";
import type { Database } from "../database/kysely.js";

export interface DocumentSectionRow {
  id: string;
  document_id: string;
  section_order: number;
  heading: string | null;
  section_type: string;
  content_markdown: string | null;
  content_text: string | null;
  metadata: unknown;
  created_at: Date;
}

export interface CreateSectionInput {
  documentId: string;
  order: number;
  heading?: string;
  type?: string;
  contentMarkdown?: string;
  contentText?: string;
  metadata?: Record<string, unknown>;
}

export interface SectionRepository {
  createBatch(inputs: CreateSectionInput[]): Promise<DocumentSectionRow[]>;
  getByDocumentId(documentId: string): Promise<DocumentSectionRow[]>;
  getMaxOrder(documentId: string): Promise<number>;
  getByDocumentIdAndType(
    documentId: string,
    sectionType: string,
  ): Promise<DocumentSectionRow[]>;
}

export function createSectionRepository(db: Kysely<Database>): SectionRepository {
  return {
    async createBatch(inputs) {
      if (inputs.length === 0) return [];
      return db
        .insertInto("document_sections")
        .values(
          inputs.map((i) => ({
            document_id: i.documentId,
            section_order: i.order,
            heading: i.heading ?? null,
            section_type: i.type ?? "paragraph",
            content_markdown: i.contentMarkdown ?? null,
            content_text: i.contentText ?? null,
            metadata: i.metadata ? JSON.stringify(i.metadata) : "{}",
          })),
        )
        .returningAll()
        .execute();
    },

    async getByDocumentId(documentId) {
      return db
        .selectFrom("document_sections")
        .selectAll()
        .where("document_id", "=", documentId)
        .orderBy("section_order", "asc")
        .execute();
    },

    async getMaxOrder(documentId) {
      const row = await db
        .selectFrom("document_sections")
        .where("document_id", "=", documentId)
        .select(sql<number>`coalesce(max(section_order), 0)`.as("max_order"))
        .executeTakeFirst();
      return Number(row?.max_order ?? 0);
    },

    async getByDocumentIdAndType(documentId, sectionType) {
      return db
        .selectFrom("document_sections")
        .selectAll()
        .where("document_id", "=", documentId)
        .where("section_type", "=", sectionType)
        .orderBy("section_order", "asc")
        .execute();
    },
  };
}
