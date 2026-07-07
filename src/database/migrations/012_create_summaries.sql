CREATE TABLE summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  prompt_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chunk_id)
);

CREATE INDEX summaries_document_id_idx ON summaries(document_id);

CREATE TABLE summary_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id UUID NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  claim_text TEXT NOT NULL,
  claim_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(summary_id, claim_order)
);

CREATE INDEX summary_citations_chunk_id_idx ON summary_citations(chunk_id);
