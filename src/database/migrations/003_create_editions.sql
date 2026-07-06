CREATE TABLE editions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_date DATE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'publishing', 'published', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB
);

CREATE INDEX editions_status_idx ON editions (status);
