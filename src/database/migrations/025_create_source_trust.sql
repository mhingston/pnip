CREATE TABLE source_trust (
  source_identity TEXT PRIMARY KEY,
  tier            SMALLINT NOT NULL DEFAULT 3,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tier BETWEEN 1 AND 5)
);
