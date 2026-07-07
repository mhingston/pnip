CREATE TABLE notebooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL UNIQUE REFERENCES editions(id) ON DELETE CASCADE,
  notebook_external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  provider_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX notebooks_edition_id_idx ON notebooks(edition_id);
CREATE INDEX notebooks_external_id_idx ON notebooks(notebook_external_id);
