CREATE TABLE prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  template TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_name_version_unique UNIQUE (name, version)
);

CREATE INDEX prompt_versions_name_idx ON prompt_versions (name);
