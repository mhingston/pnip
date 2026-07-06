CREATE TABLE document_lineage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  relation TEXT NOT NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_lineage_edge_unique UNIQUE (source_type, source_id, target_type, target_id, relation)
);

CREATE INDEX document_lineage_source_idx ON document_lineage (source_type, source_id);
CREATE INDEX document_lineage_target_idx ON document_lineage (target_type, target_id);
CREATE INDEX document_lineage_relation_idx ON document_lineage (relation);
