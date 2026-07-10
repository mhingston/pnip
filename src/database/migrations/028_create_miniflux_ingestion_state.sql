CREATE TABLE miniflux_ingestion_state (
  source_key TEXT PRIMARY KEY,
  last_entry_id BIGINT NOT NULL,
  last_ingested_at TIMESTAMPTZ NOT NULL
);
