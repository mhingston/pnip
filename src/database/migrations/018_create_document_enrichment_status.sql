CREATE TABLE document_enrichment_status (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  enrichment_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, enrichment_type)
);

CREATE INDEX document_enrichment_status_document_id_idx
  ON document_enrichment_status(document_id);

CREATE INDEX document_enrichment_status_status_idx
  ON document_enrichment_status(status);
