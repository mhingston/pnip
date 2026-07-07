CREATE TABLE quality_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  reasoning TEXT,
  prompt_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chunk_id)
);

CREATE INDEX quality_classifications_document_id_idx ON quality_classifications(document_id);
