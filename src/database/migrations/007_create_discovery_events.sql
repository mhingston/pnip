CREATE TABLE discovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL REFERENCES editions(id),
  miniflux_entry_id BIGINT NOT NULL,
  feed_id BIGINT NOT NULL,
  title TEXT,
  url TEXT NOT NULL,
  hash TEXT,
  published_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discovery_events_miniflux_entry_unique UNIQUE (miniflux_entry_id)
);

CREATE INDEX discovery_events_edition_id_idx ON discovery_events (edition_id);
CREATE INDEX discovery_events_edition_id_discovered_at_idx ON discovery_events (edition_id, discovered_at);
