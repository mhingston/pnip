CREATE TABLE email_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL UNIQUE REFERENCES editions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_addresses JSONB NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'resend',
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_response JSONB,
  provider_message_id TEXT,
  failure_reason TEXT,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_digests_edition_id_idx ON email_digests(edition_id);
CREATE INDEX email_digests_provider_message_id_idx ON email_digests(provider_message_id);
