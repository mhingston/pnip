ALTER TABLE editions
  ADD COLUMN partition_key TEXT NOT NULL DEFAULT 'master';

ALTER TABLE discovery_events
  ADD COLUMN partition_key TEXT NOT NULL DEFAULT 'master';

ALTER TABLE documents
  ADD COLUMN partition_key TEXT NOT NULL DEFAULT 'master';

CREATE INDEX discovery_events_edition_partition_idx
  ON discovery_events (edition_id, partition_key);

CREATE INDEX documents_edition_partition_idx
  ON documents (edition_id, partition_key);
