import { Kysely, PostgresDialect, type Generated } from "kysely";
import type { PgPool } from "./pool.js";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "archived";

export type EditionStatus = "building" | "ready" | "publishing" | "published" | "failed";

export interface Edition {
  id: string;
  publication_date: Date;
  status: EditionStatus;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  metadata: unknown | null;
}

export interface ProcessingJob {
  id: string;
  job_type: string;
  edition_id: string | null;
  target: unknown | null;
  status: JobStatus;
  retry_count: number;
  last_error: unknown | null;
  last_attempt_at: Date | null;
  next_eligible_at: Date;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  depends_on: string[];
}

export interface PromptVersion {
  id: string;
  name: string;
  version: number;
  template: string;
  purpose: string;
  created_at: Date;
}

export interface LineageEdge {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  metadata: unknown | null;
  created_at: Date;
}

export interface DiscoveryEvent {
  id: string;
  edition_id: string;
  miniflux_entry_id: string;
  feed_id: string;
  title: string | null;
  url: string;
  hash: string | null;
  published_at: Date | null;
  discovered_at: Date;
  metadata: unknown | null;
  created_at: Date;
}

export interface EntityRef {
  type: string;
  id: string;
}

export interface Database {
  processing_jobs: {
    id: Generated<string>;
    job_type: string;
    edition_id: string | null;
    target: unknown | null;
    status: Generated<JobStatus>;
    retry_count: Generated<number>;
    last_error: unknown | null;
    last_attempt_at: Date | null;
    next_eligible_at: Generated<Date>;
    locked_by: string | null;
    locked_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    completed_at: Date | null;
    depends_on: Generated<string[]>;
  };
  editions: {
    id: Generated<string>;
    publication_date: Date;
    status: Generated<EditionStatus>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    published_at: Date | null;
    failed_at: Date | null;
    failure_reason: string | null;
    metadata: unknown | null;
  };
  prompt_versions: {
    id: Generated<string>;
    name: string;
    version: number;
    template: string;
    purpose: string;
    created_at: Generated<Date>;
  };
  document_lineage: {
    id: Generated<string>;
    source_type: string;
    source_id: string;
    target_type: string;
    target_id: string;
    relation: string;
    metadata: unknown | null;
    created_at: Generated<Date>;
  };
  documents: {
    id: Generated<string>;
    edition_id: string;
    source_type: string;
    source_url: string;
    canonical_url: string | null;
    title: string | null;
    subtitle: string | null;
    authors: unknown;
    publisher: string | null;
    published_at: Date | null;
    language: Generated<string>;
    content_markdown: string | null;
    content_text: string | null;
    metadata: unknown;
    created_at: Generated<Date>;
  };
  document_sections: {
    id: Generated<string>;
    document_id: string;
    section_order: number;
    heading: string | null;
    section_type: Generated<string>;
    content_markdown: string | null;
    content_text: string | null;
    metadata: unknown;
    created_at: Generated<Date>;
  };
  document_chunks: {
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
    created_at: Generated<Date>;
  };
  summaries: {
    id: Generated<string>;
    chunk_id: string;
    document_id: string;
    content: string;
    prompt_id: string;
    prompt_version: number;
    model: string;
    provider: string;
    input_hash: string;
    created_at: Generated<Date>;
  };
  summary_citations: {
    id: Generated<string>;
    summary_id: string;
    chunk_id: string;
    claim_text: string;
    claim_order: number;
    created_at: Generated<Date>;
  };
  entities: {
    id: Generated<string>;
    chunk_id: string;
    document_id: string;
    name: string;
    entity_type: string;
    prompt_id: string;
    prompt_version: number;
    model: string;
    provider: string;
    input_hash: string;
    created_at: Generated<Date>;
  };
  entity_mentions: {
    id: Generated<string>;
    entity_id: string;
    chunk_id: string;
    mention_text: string;
    created_at: Generated<Date>;
  };
  topics: {
    id: Generated<string>;
    chunk_id: string;
    document_id: string;
    topic: string;
    confidence: number;
    prompt_id: string;
    prompt_version: number;
    model: string;
    provider: string;
    input_hash: string;
    created_at: Generated<Date>;
  };
  topic_assignments: {
    id: Generated<string>;
    topic_id: string;
    chunk_id: string;
    relevance: number;
    created_at: Generated<Date>;
  };
  quality_classifications: {
    id: Generated<string>;
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
    created_at: Generated<Date>;
  };
  embeddings: {
    id: Generated<string>;
    chunk_id: string;
    vector: unknown;
    model: string;
    provider: string;
    input_hash: string;
    created_at: Generated<Date>;
  };
  discovery_events: {
    id: Generated<string>;
    edition_id: string;
    miniflux_entry_id: string;
    feed_id: string;
    title: string | null;
    url: string;
    hash: string | null;
    published_at: Date | null;
    discovered_at: Generated<Date>;
    metadata: unknown | null;
    created_at: Generated<Date>;
  };
}

export function createKysely(pool: PgPool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function closeKysely(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
