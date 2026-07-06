CREATE TABLE document_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_order INTEGER NOT NULL,
  heading TEXT,
  section_type TEXT NOT NULL DEFAULT 'paragraph',
  content_markdown TEXT,
  content_text TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, section_order)
);
