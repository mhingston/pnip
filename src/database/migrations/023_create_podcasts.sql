CREATE TABLE podcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL UNIQUE REFERENCES editions(id) ON DELETE CASCADE,
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  artifact_external_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  duration_seconds INTEGER,
  format TEXT,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  local_path TEXT,
  provider_response JSONB,
  failure_reason TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX podcasts_edition_id_idx ON podcasts(edition_id);
CREATE INDEX podcasts_notebook_id_idx ON podcasts(notebook_id);
CREATE INDEX podcasts_artifact_external_id_idx ON podcasts(artifact_external_id);
