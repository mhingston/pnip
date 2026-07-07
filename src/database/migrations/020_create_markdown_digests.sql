CREATE TABLE markdown_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL UNIQUE REFERENCES editions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  story_count INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  citation_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX markdown_digests_edition_id_idx ON markdown_digests(edition_id);
