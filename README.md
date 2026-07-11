# PNIP — Personal News Intelligence Pipeline

PNIP turns a Miniflux feed collection into a daily intelligence edition:

- a canonical Markdown digest;
- an HTML email delivered through Resend;
- a source-grounded NotebookLM notebook; and
- an optional NotebookLM-generated podcast.

It is a self-hosted TypeScript/Node application backed by PostgreSQL. Processing is queued, resumable, idempotent, and provenance-aware: generated stories can be traced back to source documents and chunks.

## Current behavior

Discovery requests both read and unread entries, advances a local ingestion checkpoint, and deduplicates by Miniflux entry ID. When a new daily edition boundary is first opened, PNIP marks all Miniflux feeds read once; this only resets the reader's unread badge. Manual reading remains available, and entries continue to be ingested regardless of their read state.

If discovery is asked to use an edition that is already ready, publishing, or published, it routes entries to the next open daily edition so an immutable digest is never changed by late arrivals.

The Markdown digest currently:

- omits the redundant “Today in brief” section;
- links each story title to its lead source;
- has no numbered citation markers;
- lists every ingested source, ordered by edition ranking; and
- includes up to 50 lead stories by default, while retaining the complete story/source set.

The NotebookLM notebook uploads the curated source URLs/files, not the Markdown synthesis. A notebook is capped at 50 sources by default; overflow is recorded for audit and remains present in the Markdown digest.

## Requirements

- Node.js 22 or newer
- PostgreSQL 14 or newer with pgvector
- Miniflux and an API token
- An AI provider for enrichment (OpenAI, an OpenAI-compatible endpoint, or the deterministic fake provider)
- Resend for email delivery
- notebooklm-py for notebooks and podcasts
- Fabric for live article, YouTube, podcast, and Reddit extraction
- MarkItDown for PDF extraction

Fabric, MarkItDown, Resend, and NotebookLM are only required for the stages that use them. Tests can run with AI_PROVIDER=fake and mocked external services.

## Setup

1. Install dependencies and copy the environment template:

~~~bash
npm install
cp .env.example .env
~~~

2. Set at least DATABASE_URL, MINIFLUX_URL, and MINIFLUX_API_TOKEN. Add the credentials for the outputs you want to produce.

3. Verify the installation:

~~~bash
npm run digestive -- doctor
~~~

Every CLI invocation runs pending database migrations before executing the command.

## Daily workflow

For a single edition, use:

~~~bash
DATE=$(date +%F)

npm run digestive -- discover --date "$DATE"
npm run digestive -- process
npm run digestive -- generate-digest --date "$DATE"
npm run digestive -- generate-edition --date "$DATE"
npm run digestive -- generate-notebook --date "$DATE" --wait
npm run digestive -- generate-podcast --date "$DATE" --wait
npm run digestive -- generate-email --date "$DATE"
npm run digestive -- publish-edition --date "$DATE"
~~~

Podcast generation is best-effort and does not block publication. Notebook readiness, Markdown, email delivery, and any active partition notebooks are publication requirements.

The recommended automated workflow is:

~~~bash
scripts/cron-install.sh install
~~~

This installs a Miniflux/processing drain every 10 minutes, a six-hour maintenance apply (including the 30-day retention purge), and a daily publication trigger. Use scripts/daily-publish.sh directly when you need a one-shot publication sequence. Set PNIP_PUBLISH_DATE to publish a specific edition and PNIP_DRY_RUN=1 to stop after the publication gate check.

## CLI reference

All commands support -h and --help. Dates default to today.

### Ingestion and publication

| Command | Purpose |
| --- | --- |
| digestive discover | Ingest new read or unread Miniflux entries; reset Miniflux feed read state once per new edition boundary |
| digestive process | Drain the processing queue until it is empty |
| digestive generate-digest | Render the canonical Markdown digest |
| digestive generate-edition | Evaluate the Building → Ready enrichment gate |
| digestive generate-email | Render and send the HTML email; --dry-run skips sending |
| digestive generate-notebook | Create/resume a NotebookLM notebook; --partition selects a partition; --wait waits for source ingestion |
| digestive generate-podcast | Start/resume podcast generation; --partition selects a partition; --wait waits for the artifact |
| digestive publish-edition | Gate-check and publish; --dry-run is read-only |

### Operations

| Command | Purpose |
| --- | --- |
| digestive doctor | Check configuration, PostgreSQL, migrations, queue, workers, and configured integrations |
| digestive metrics | Read-only queue, throughput, latency, edition, and partition metrics |
| digestive partitions | Read-only document counts and recent per-partition activity |
| digestive retry | List/requeue failed jobs; use --dry-run first |
| digestive maintenance | Preview by default; `--apply` cleans the queue and purges edition-linked data older than 30 days |
| digestive active-partitions --date YYYY-MM-DD | Print partitions active for an edition |

Retry filters include edition ID, worker/job type, age, and limit. Maintenance supports archive-after, purge-after, retention-after, and limit durations using s, m, h, or d suffixes. The installed cron invokes `maintenance --apply --retention-after 30d`; edition-linked source data, chunks, enrichment rows, embeddings, artifact rows, discovery events, lineage, old jobs, and their NotebookLM notebooks are removed after 30 days. Archived queue rows use the same 30-day purge age; already-downloaded podcast files are outside PostgreSQL retention.

### Feedback and source trust

~~~bash
digestive feedback rate <edition_id> <story_id> --up
digestive feedback rate <edition_id> <story_id> --down
digestive feedback hide <source_url>
digestive feedback star <chunk_id>

digestive source-trust set <source_identity> <tier> [--notes "..."]
digestive source-trust get <source_identity>
digestive source-trust list
digestive source-trust delete <source_identity>

digestive feedback-summary [--edition YYYY-MM-DD]
~~~

Feedback is self-attributed. DIGEST_BIAS_ENABLED=true applies muted-source suppression and moves down-rated stories later in the digest. Source-trust tiers can be used by clustering to reorder stories.

## Partitions

Every document belongs to the master partition. Master is always active and contains the complete edition. Optional partitions are selected from Miniflux categories by PARTITION_CONFIG.

~~~bash
PARTITION_CONFIG='{"youtube":{"category":"YouTube","min_articles":5,"enabled":true,"with_podcast":true},"reddit":{"category":"Reddit","min_articles":3,"enabled":true}}'
~~~

A non-master partition is active only when enabled and its document count meets min_articles (default 5). Active partitions get their own NotebookLM notebook; with_podcast=true also starts a partition podcast. The master notebook and Markdown digest are not reduced by partition caps.

Notebook source selection is deterministic:

1. story cluster order;
2. best per-document quality label;
3. average quality confidence; and
4. document ID.

NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK changes the per-notebook cap (default 50). Excluded notebook sources produce notebook_excluded signals but remain in the edition and digest.

## Environment

The complete schema is in .env.example. The main settings are:

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | PostgreSQL connection string |
| TEST_DATABASE_URL | PostgreSQL connection string for integration tests |
| MINIFLUX_URL / MINIFLUX_API_TOKEN | Miniflux discovery |
| AI_PROVIDER | openai (default), openai-compatible, or fake |
| OPENAI_API_KEY / OPENAI_BASE_URL | OpenAI or compatible provider credentials |
| AI_TEXT_MODEL | Text model override |
| EMBEDDING_MODEL / EMBEDDING_CACHE_DIR | Embedding model and local cache |
| RESEND_API_KEY / EMAIL_FROM / EMAIL_RECIPIENT | Email delivery |
| FABRIC_BIN / MARKITDOWN_BIN | Extraction CLI paths |
| NOTEBOOKLM_OUTPUT_DIR | Podcast download directory (default ./notebooks) |
| NOTEBOOKLM_HEADLESS | NotebookLM CLI mode |
| NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK | Notebook source cap (default 50) |
| PARTITION_CONFIG | Optional category-to-partition JSON |
| DIGEST_BIAS_ENABLED | Enable feedback biasing |
| DIGEST_TARGET_READING_MINUTES | Calibrate lead-story prominence |
| DIGEST_QUIET_EDITION_REASON | Explicit low-significance/low-novelty framing |
| DOCTOR_FAILED_THRESHOLD | Queue failure threshold (default 100) |
| WORKER_CONCURRENCY / RETRY_MAX_ATTEMPTS | Worker and retry tuning |
| LOG_LEVEL | debug, info, warn, or error |

## Development

~~~bash
npm test
npm run typecheck
npm run test:watch
~~~

Integration tests use TEST_DATABASE_URL and require PostgreSQL with pgvector. The project has no build step; the CLI runs through tsx.

## Project layout

~~~text
src/cli             Command-line surface
src/config          Environment parsing and partition configuration
src/database        PostgreSQL schema, migrations, and Kysely types
src/discovery       Miniflux client, discovery, cursor, and partition routing
src/expansion       Article, YouTube, podcast, PDF, and Reddit plugins
src/chunking        Deterministic chunks and provenance
src/enrichment      Summaries, entities, topics, embeddings, and quality
src/clustering      Story clustering and story summaries
src/editions        Edition lifecycle, readiness, and assembly
src/digest          Markdown, email, NotebookLM, and podcast outputs
src/publication     Publication gate and state transitions
src/signals         Feedback, source identity, bias, and source trust
src/retention       30-day edition/content and queue cleanup
scripts             Cron and daily-publication helpers
ARCHITECTURE.md     Current design decisions and invariants
~~~

For implementation details and invariants, see [ARCHITECTURE.md](ARCHITECTURE.md).
