# PNIP Architecture

This document describes the design that the running application implements.

## System shape

~~~text
Miniflux
   │ read + unread entries, ordered by entry ID
   ▼
DiscoveryEvent + ingestion checkpoint
   │
   ▼
Processing queue
   │
   ├─ expansion plugins → canonical documents → sections
   ├─ deterministic chunks + provenance
   └─ five enrichment workers
          ├─ chunk summaries
          ├─ entities
          ├─ topics
          ├─ embeddings
          └─ quality labels/confidence
                         │
                         ▼
                 story clustering
                         │
                         ▼
                 story summaries + citations
                         │
                         ▼
                      Edition
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        Markdown       Email      NotebookLM
                                      │
                                      ▼
                                   Podcast
                                      │
                                      ▼
                                  Publish
~~~

The CLI is the orchestration boundary. Domain services communicate through repositories and queue jobs; workers do not depend on an in-memory pipeline run.

## Ingestion and idempotency

PNIP calls the Miniflux entries endpoint with read and unread status filters, ordered by ascending ID. Ingestion is independent of read state. At the first successful discovery poll for an open edition, PNIP calls Miniflux's per-feed mark-all-as-read endpoint once and records `editions.miniflux_read_reset_at`; a failed reset is retried on a later poll. This resets the reader's unread badge without changing PNIP's ingestion cursor.

The miniflux_ingestion_state table stores a singleton checkpoint:

- last_entry_id — the last successfully persisted/queued Miniflux entry;
- last_ingested_at — when PNIP advanced the checkpoint.

The DiscoveryEvent table also stores the Miniflux hash, URL, feed ID, title, and publication timestamp. The hash is retained as source metadata; the stable Miniflux entry ID is the deduplication key.

For an existing database, the first run without a checkpoint starts after the highest already-recorded Miniflux entry ID. This avoids replaying entries PNIP has already imported. A fresh database with no prior events has no cursor and can ingest retained Miniflux history on its first run.

Each successful entry is handled in one transaction:

1. resolve the destination partition;
2. insert or find the DiscoveryEvent;
3. enqueue expand_document only for a newly inserted event; and
4. advance the checkpoint.

If persistence or enqueueing fails, the checkpoint remains at the last contiguous successful entry. The failed entry is retried on a later poll. Repeated polls are safe because both the DiscoveryEvent uniqueness constraint and queue semantics are idempotent.

## Edition lifecycle

An Edition is identified by publication date and has one of these states:

~~~text
building → ready → publishing → published
                     └──────→ failed
~~~

Discovery starts with the edition date supplied to the command (normally today). If that date's edition is ready, publishing, or published, discovery walks forward to the next open date and creates or reuses a mutable edition there. The entry publication timestamp is stored for provenance but does not otherwise move an entry between editions.

The readiness gate requires every edition document to complete the five enrichment types and every story to have a story summary. generate-edition evaluates that gate and transitions Building to Ready.

Publication requires:

- a non-empty Markdown digest;
- a sent email;
- a ready master NotebookLM notebook; and
- a ready NotebookLM notebook for each active non-master partition.

Podcast generation is best-effort. A missing or failed podcast is logged but does not block publication, including configured partition podcasts.

Publishing transitions the edition through Publishing to Published and cancels remaining mutable processing jobs for that edition. Published editions are immutable; reruns are no-ops or status reads.

## Canonical content pipeline

Expansion converts an ingested URL into a canonical document. Plugins currently cover:

- articles;
- YouTube videos;
- podcasts;
- PDFs; and
- Reddit submissions/discussions.

Canonical documents are split into ordered sections. Chunk IDs and lineage edges are deterministic, so downstream enrichment can be retried without losing provenance.

The five enrichment workers produce chunk summaries, entities, topics, embeddings, and quality classifications. Embeddings drive clustering; quality labels and confidence are also used for NotebookLM source selection.

Story clustering creates ordered story clusters. Story summaries contain a narrative summary plus key claims tied to source chunks. The Markdown renderer keeps the source links but deliberately omits numbered citation tokens from the reader-facing output.

## Digest and output policy

The Markdown digest is the canonical editorial artifact. It contains:

- a coverage receipt;
- Top Stories (up to 50 by default);
- More Stories and continuing coverage when applicable; and
- Sources, with every ingested source linked and ordered by edition ranking.

Story headings link to the lead document. The source list uses the publisher name when available, otherwise the document title. The email is rendered from this Markdown artifact.

The optional DIGEST_TARGET_READING_MINUTES setting changes how many new stories are promoted into Top Stories; it does not remove stories or sources from the canonical digest. DIGEST_BIAS_ENABLED enables the feedback-based suppression/reordering policy.

NotebookLM receives the curated source URLs/files for the selected partition. It does not receive the Markdown synthesis. A per-notebook source cap defaults to 50; excluded documents remain in the Markdown digest and produce notebook_excluded signals.

## Partitions

Master is the complete edition. Every document has a partition_key, with master as the default. Miniflux categories are mapped to configured non-master keys by category name or category ID.

A non-master partition is active when enabled and its document count reaches min_articles. Active partitions produce their own notebook and optionally their own podcast. Partitioning affects NotebookLM artifacts and publication gating; it does not remove documents from the master Markdown digest.

Notebook source ranking is deterministic:

1. minimum story cluster order;
2. best quality label (high, medium, low, then unclassified);
3. average quality confidence, descending; and
4. document ID ascending.

## Feedback and trust

Signals are written for story votes, muted sources, starred chunks, clustering, digest lead selection, and notebook exclusions. Source identities normalize publishers/hosts/subreddits so feedback can apply across URLs.

DIGEST_BIAS_ENABLED is opt-in. It removes a story only when all of its documents belong to muted sources and moves down-rated stories later. Source-trust tiers can reorder clusters during clustering.

## Queue, retries, and maintenance

Jobs have pending, running, completed, failed, and archived states. Worker claims are lease-based, and stale running jobs can be recovered. Retry requeues failed jobs; maintenance archives old completed/failed jobs and purges old archived jobs.

Maintenance runs a 30-day retention transaction when invoked with `--apply`: it removes old edition-linked source data, sections/chunks, enrichment rows, embeddings, artifact rows, discovery events, lineage, and old jobs. Queue archive/purge defaults also retain archived jobs for 30 days. The edition delete cascades through the relational content graph; lineage is explicitly cleaned because it is intentionally schema-less. External NotebookLM assets and already-downloaded podcast files are outside PostgreSQL retention. The cron installer schedules this apply pass every six hours with a row limit safety cap.

The cron helpers are operational conveniences, not part of the scheduler runtime:

- scripts/digest-drain.sh runs discovery and queue processing;
- scripts/daily-publish.sh sequences output generation and publication; and
- scripts/cron-install.sh installs/removes the managed cron block.

## Deliberate boundaries

- Miniflux remains the user's reading application; PNIP only performs the once-per-edition unread reset and never uses read state as an ingestion filter.
- PostgreSQL is the source of truth after discovery.
- Markdown is the canonical digest; email is a presentation of it.
- NotebookLM is a source-grounded convenience artifact, not the archive.
- Published editions are immutable.
- Per-partition finalization schedules are not implemented; all partitions follow the edition's publication timing.
