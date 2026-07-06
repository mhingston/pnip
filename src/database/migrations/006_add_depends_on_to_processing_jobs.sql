ALTER TABLE processing_jobs ADD COLUMN depends_on uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX processing_jobs_depends_on_idx ON processing_jobs USING GIN (depends_on);
