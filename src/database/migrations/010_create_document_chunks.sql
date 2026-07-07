CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_id UUID NOT NULL REFERENCES document_sections(id) ON DELETE CASCADE,
  chunk_sequence INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  paragraph_start INTEGER NOT NULL,
  paragraph_end INTEGER NOT NULL,
  timestamp_start DOUBLE PRECISION,
  timestamp_end DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, section_id, chunk_sequence)
);
CREATE INDEX idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX idx_document_chunks_section_id ON document_chunks(section_id);
