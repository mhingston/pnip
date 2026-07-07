CREATE TABLE topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  prompt_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chunk_id, topic)
);

CREATE INDEX topics_document_id_idx ON topics(document_id);
CREATE INDEX topics_chunk_id_idx ON topics(chunk_id);

CREATE TABLE topic_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  relevance DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(topic_id, chunk_id)
);

CREATE INDEX topic_assignments_chunk_id_idx ON topic_assignments(chunk_id);
