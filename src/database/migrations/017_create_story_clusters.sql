CREATE TABLE story_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  cluster_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(edition_id, label)
);

CREATE INDEX story_clusters_edition_id_idx ON story_clusters(edition_id);

CREATE TABLE cluster_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'supporting'
    CHECK (role IN ('supporting', 'contradicting')),
  similarity DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(story_id, document_id)
);

CREATE INDEX cluster_members_story_id_idx ON cluster_members(story_id);
CREATE INDEX cluster_members_document_id_idx ON cluster_members(document_id);

CREATE TABLE story_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL UNIQUE REFERENCES story_clusters(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  prompt_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE story_summary_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_summary_id UUID NOT NULL REFERENCES story_summaries(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  claim_text TEXT NOT NULL,
  claim_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(story_summary_id, claim_order)
);

CREATE INDEX story_summary_citations_chunk_id_idx ON story_summary_citations(chunk_id);
