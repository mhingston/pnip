CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  prompt_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chunk_id, name, entity_type)
);

CREATE INDEX entities_document_id_idx ON entities(document_id);
CREATE INDEX entities_chunk_id_idx ON entities(chunk_id);

CREATE TABLE entity_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  mention_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(entity_id, chunk_id)
);

CREATE INDEX entity_mentions_chunk_id_idx ON entity_mentions(chunk_id);
