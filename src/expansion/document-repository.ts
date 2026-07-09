import { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";

export interface DocumentRow {
  id: string;
  edition_id: string;
  source_type: string;
  source_url: string;
  canonical_url: string | null;
  title: string | null;
  subtitle: string | null;
  authors: unknown;
  publisher: string | null;
  published_at: Date | null;
  language: string;
  content_markdown: string | null;
  content_text: string | null;
  metadata: unknown;
  created_at: Date;
  partition_key: string;
}

export interface CreateDocumentInput {
  editionId: string;
  sourceType: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedAt?: Date;
  language?: string;
  contentMarkdown?: string;
  contentText?: string;
  metadata?: Record<string, unknown>;
  partitionKey?: string;
}

export interface DocumentRepository {
  create(input: CreateDocumentInput): Promise<DocumentRow>;
  getById(id: string): Promise<DocumentRow | undefined>;
  getByEdition(editionId: string): Promise<DocumentRow[]>;
  getByEditionAndUrl(editionId: string, sourceUrl: string): Promise<DocumentRow | undefined>;
  getByEditionAndPartition(editionId: string, partitionKey: string): Promise<DocumentRow[]>;
}

export function createDocumentRepository(db: Kysely<Database>): DocumentRepository {
  return {
    async create(input): Promise<DocumentRow> {
      return db
        .insertInto("documents")
        .values({
          edition_id: input.editionId,
          source_type: input.sourceType,
          source_url: input.sourceUrl,
          canonical_url: input.canonicalUrl ?? null,
          title: input.title ?? null,
          subtitle: input.subtitle ?? null,
          authors: input.authors ? JSON.stringify(input.authors) : undefined,
          publisher: input.publisher ?? null,
          published_at: input.publishedAt ?? null,
          language: input.language ?? "en",
          content_markdown: input.contentMarkdown ?? null,
          content_text: input.contentText ?? null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
          partition_key: input.partitionKey ?? "master",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async getById(id) {
      return db
        .selectFrom("documents")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("documents")
        .selectAll()
        .where("edition_id", "=", editionId)
        // Determinism: created_at is millisecond-resolution; documents inserted in
        // the same run share an identical created_at and Postgres's order between
        // ties is undefined. source_url is a stable canonical tiebreak so the
        // clusterer always receives the same input order for the same Edition.
        .orderBy("created_at", "asc")
        .orderBy("source_url", "asc")
        .execute();
    },

    async getByEditionAndUrl(editionId, sourceUrl) {
      return db
        .selectFrom("documents")
        .selectAll()
        .where("edition_id", "=", editionId)
        .where("source_url", "=", sourceUrl)
        .executeTakeFirst();
    },

    async getByEditionAndPartition(editionId, partitionKey) {
      return db
        .selectFrom("documents")
        .selectAll()
        .where("edition_id", "=", editionId)
        .where("partition_key", "=", partitionKey)
        .orderBy("created_at", "asc")
        .orderBy("source_url", "asc")
        .execute();
    },
  };
}
