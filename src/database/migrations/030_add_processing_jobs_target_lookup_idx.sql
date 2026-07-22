-- pnip: non-transactional
-- The JSONB target fields are used by enrichment readiness checks. Keep this
-- partial and concurrent so the live queue remains writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS processing_jobs_target_document_chunk_idx
  ON processing_jobs (
    (target->>'documentId'),
    edition_id,
    job_type,
    status,
    (target->>'chunkId')
  )
  WHERE target ? 'chunkId';
