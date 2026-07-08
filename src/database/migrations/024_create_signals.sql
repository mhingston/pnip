CREATE TABLE signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_kind     TEXT NOT NULL,
  edition_id      UUID NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  story_id        UUID REFERENCES story_clusters(id) ON DELETE SET NULL,
  chunk_id        TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_url      TEXT,
  source_identity TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX signals_edition_id_idx ON signals (edition_id);
CREATE INDEX signals_signal_kind_idx ON signals (signal_kind);
CREATE INDEX signals_edition_kind_idx ON signals (edition_id, signal_kind);
CREATE INDEX signals_source_identity_idx ON signals (source_identity);
