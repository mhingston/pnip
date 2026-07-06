CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  subtitle TEXT,
  authors JSONB DEFAULT '[]'::jsonb,
  publisher TEXT,
  published_at TIMESTAMPTZ,
  language TEXT NOT NULL DEFAULT 'en',
  content_markdown TEXT,
  content_text TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(edition_id, source_url)
);
