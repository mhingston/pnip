-- Remove embedding storage from databases upgraded from pre-editorial PNIP.
DROP TABLE IF EXISTS embeddings CASCADE;
DROP EXTENSION IF EXISTS vector CASCADE;
