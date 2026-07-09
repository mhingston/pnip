ALTER TABLE notebooks
  ADD COLUMN partition_key TEXT NOT NULL DEFAULT 'master';

ALTER TABLE notebooks
  DROP CONSTRAINT IF EXISTS notebooks_edition_id_key;

ALTER TABLE notebooks
  ADD CONSTRAINT notebooks_edition_partition_unique
  UNIQUE (edition_id, partition_key);

CREATE INDEX notebooks_edition_partition_idx
  ON notebooks (edition_id, partition_key);

CREATE INDEX notebooks_external_id_partition_idx
  ON notebooks (notebook_external_id, partition_key);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'podcasts'
  ) THEN
    EXECUTE 'ALTER TABLE podcasts ADD COLUMN partition_key TEXT NOT NULL DEFAULT ''master''';
    EXECUTE 'ALTER TABLE podcasts DROP CONSTRAINT IF EXISTS podcasts_edition_id_key';
    EXECUTE 'ALTER TABLE podcasts ADD CONSTRAINT podcasts_edition_partition_unique UNIQUE (edition_id, partition_key)';
    EXECUTE 'CREATE INDEX podcasts_edition_partition_idx ON podcasts (edition_id, partition_key)';
  END IF;
END $$;
