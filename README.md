# PNIP — Personal News Intelligence Pipeline

> [!IMPORTANT]
> PNIP is an open-source snapshot of a pipeline tailored to my personal setup, rather than a general-purpose hosted product.
>
> I run a self-hosted [Miniflux](https://miniflux.app/) server as the feed aggregator. My feeds are organised into three Miniflux categories. PNIP polls Miniflux, ingests and enriches the collected entries, assembles daily digests, then publishes them by email and to [NotebookLM](https://notebooklm.google/).
>
> The code is reusable, but it assumes a similar collection of services and reflects my editorial, scheduling, retention, and publication choices. Expect to adapt the category mapping, prompts, extraction tools, providers, and cron schedule for another deployment.

PNIP turns a Miniflux feed collection into a daily, source-grounded news digest.

It produces:

- a canonical Markdown digest;
- an HTML email delivered through Resend;
- a NotebookLM notebook populated with the curated source material; and
- optional NotebookLM-generated audio overviews.

PNIP is a self-hosted TypeScript/Node.js application backed by PostgreSQL and pgvector. Processing is queued, resumable, idempotent, and provenance-aware, so generated stories can be traced back to their source documents and chunks.

## How it fits together

```text
Feeds, newsletters, YouTube, Reddit, podcasts, PDFs, ...
                              │
                              ▼
                        Miniflux server
                  aggregation + three categories
                              │
                              ▼
                      PNIP discovery cursor
                              │
                              ▼
            expand → chunk → enrich → embed → cluster
                              │
                              ▼
                     daily edition assembly
                         │              │
                         ▼              ▼
                  Markdown + email   NotebookLM
                                         │
                                         ▼
                                  optional podcast
```

Miniflux remains responsible for fetching and aggregating feeds. PNIP consumes the resulting entries and is responsible for content extraction, enrichment, clustering, digest generation, and publication.

## Opinionated defaults

The current implementation deliberately makes several choices that may not suit every deployment:

- PNIP discovers both read and unread Miniflux entries and deduplicates them by Miniflux entry ID.
- A local monotonic cursor prevents the full Miniflux history being replayed on every run.
- When a new daily edition is opened, PNIP marks all Miniflux feeds as read once. This resets Miniflux's unread badge; it does not prevent manual reading or later ingestion.
- If too few new entries are available, PNIP can fill an edition from a bounded recent lookback.
- Historical fill prefers articles and YouTube over lower-signal Reddit entries by default.
- Published editions are immutable. Late entries are routed to the next open edition.
- The canonical Markdown digest retains the complete assembled story and source set.
- NotebookLM notebooks have a configurable source cap. Sources excluded from NotebookLM remain in the Markdown digest and audit trail.
- Podcast generation is optional and asynchronous; it does not block publication.
- The supplied cron configuration applies a 30-day retention policy.

## Requirements

### Core

- Node.js 22 or newer
- PostgreSQL 14 or newer with pgvector
- A Miniflux server and API token

### Integrations

Use only the integrations needed by the stages you intend to run:

- OpenAI, an OpenAI-compatible endpoint, or the deterministic fake provider for enrichment
- Resend for email delivery
- `notebooklm-py` for NotebookLM notebooks and audio overviews
- Fabric for live article, YouTube, podcast, and Reddit extraction
- MarkItDown for PDF extraction

Tests can run with `AI_PROVIDER=fake` and mocked external services.

## Getting started

### 1. Install dependencies

```bash
npm install
cp .env.example .env
```

### 2. Configure the required services

At minimum, set:

```dotenv
DATABASE_URL=postgres://user:password@127.0.0.1:5432/pnip
MINIFLUX_URL=http://127.0.0.1:8080
MINIFLUX_API_TOKEN=replace-me
```

Then configure the AI, email, and NotebookLM integrations you plan to use. The complete configuration reference is below.

### 3. Map the Miniflux categories

My deployment organises its feeds into three Miniflux categories. `PARTITION_CONFIG` maps those categories to named PNIP partitions, allowing selected categories to receive their own NotebookLM notebook and optional podcast.

Replace the category names with the exact titles used by your Miniflux instance:

```dotenv
PARTITION_CONFIG={"articles":{"category":"Articles","min_articles":5,"enabled":true},"youtube":{"category":"YouTube","min_articles":5,"enabled":true,"with_podcast":true},"reddit":{"category":"Reddit","min_articles":3,"enabled":true}}
```

Every document is always included in the `master` partition. `PARTITION_CONFIG` controls additional partition routing and outputs; it is **not** an ingestion allow-list. Entries from unmatched Miniflux categories still enter the master edition.

Leave `PARTITION_CONFIG` empty for a master-only deployment.

### 4. Verify the installation

```bash
npm run digestive -- doctor
```

Every CLI invocation runs pending database migrations before executing the requested command.

### 5. Run one edition manually

```bash
DATE=$(date +%F)

npm run digestive -- discover --date "$DATE"
npm run digestive -- process --date "$DATE" --max-jobs 10000
npm run digestive -- generate-digest --date "$DATE"
npm run digestive -- generate-notebook --date "$DATE" --wait
npm run digestive -- generate-email --date "$DATE"
npm run digestive -- generate-edition --date "$DATE"
npm run digestive -- publish-edition --date "$DATE"
```

To create an audio overview after the notebook is ready:

```bash
npm run digestive -- generate-podcast --date "$DATE" --wait
```

The commands are idempotent. Re-running a completed stage resumes or returns the existing artifact rather than intentionally creating a duplicate.

## Automated operation

Install the recommended cron schedule with:

```bash
scripts/cron-install.sh install
```

The default schedule is:

| Schedule | Action | Purpose |
| --- | --- | --- |
| `*/10 * * * *` | `digest-drain.sh` | Discover Miniflux entries and process a bounded queue batch |
| `*/10 * * * *` | `podcast-drain.sh` | Resume NotebookLM audio generation when notebooks are ready |
| `0 */6 * * *` | maintenance | Clean the queue and apply the 30-day retention policy |
| `0 6 * * *` | `daily-publish.sh` | Assemble and publish the local day's edition |

All schedules use the host's local timezone. Customise them during installation:

```bash
scripts/cron-install.sh install \
  --schedule-drain "*/15 * * * *" \
  --schedule-publish "30 5 * * *"
```

Other commands:

```bash
scripts/cron-install.sh show
scripts/cron-install.sh remove
```

See [`scripts/README.md`](scripts/README.md) for the full operational sequence.

## Configuration reference

PNIP loads `.env` through `dotenv`. `DATABASE_URL` is the only globally required schema value; other credentials become required when their corresponding command is used.

### Database, tests, and logging

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. Must begin with `postgres`. |
| `TEST_DATABASE_URL` | Tests | — | Separate PostgreSQL connection string used by integration tests. |
| `LOG_LEVEL` | No | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |
| `DOCTOR_FAILED_THRESHOLD` | No | internal default | Positive queue-failure threshold used by `digestive doctor`. |

### Miniflux

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MINIFLUX_URL` | For discovery | — | Base URL of the Miniflux server. |
| `MINIFLUX_API_TOKEN` | For discovery | — | Miniflux API token. |
| `PARTITION_CONFIG` | No | master only | JSON object mapping Miniflux categories to PNIP partitions. See [Partition configuration](#partition-configuration). |

PNIP's discovery call reads all entries exposed by the configured Miniflux account. Limit the source collection in Miniflux itself when only specific categories or feeds should be available to PNIP.

### AI and embeddings

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AI_PROVIDER` | No | `openai` | `openai`, `openai-compatible`, or `fake`. |
| `OPENAI_API_KEY` | For OpenAI providers | — | API key used by the OpenAI or OpenAI-compatible provider. |
| `OPENAI_BASE_URL` | No | provider-dependent | Overrides the OpenAI-compatible API base URL. The local fallback for `openai-compatible` is `http://localhost:20128/v1`. |
| `AI_TEXT_MODEL` | No | provider default | Overrides the model used for text enrichment and story summarisation. |
| `EMBEDDING_MODEL` | No | `Xenova/all-MiniLM-L6-v2` | Hugging Face Transformers.js embedding model. The default produces 384-dimensional vectors. |
| `EMBEDDING_CACHE_DIR` | No | library default | Local cache directory for the embedding model. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | — | Reserved in the current configuration schema. It is not used by the currently selectable AI providers. |

`AI_PROVIDER=fake` uses deterministic text and embedding providers intended for development and tests.

### Content extraction

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FABRIC_BIN` | For supported live extraction | `fabric` | Path or command name for the Fabric CLI. |
| `MARKITDOWN_BIN` | For PDF extraction | `markitdown` | Path or command name for the MarkItDown CLI. |
| `REDDIT_REFRESH_STRATEGY` | No | — | Reserved configuration value. It is currently accepted by the schema but not read by the runtime. |

### Email delivery

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | For email | — | Resend API key. |
| `EMAIL_FROM` | For email | — | Sender address accepted by Resend, including an optional display name. |
| `EMAIL_RECIPIENT` | For email delivery | empty list | One or more recipients separated by commas, semicolons, or whitespace. |

`generate-email --dry-run` renders the email without sending it.

### NotebookLM and podcasts

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NOTEBOOKLM_OUTPUT_DIR` | No | `./notebooks` | Directory used for downloaded podcast files. |
| `NOTEBOOKLM_HEADLESS` | No | tool default | Controls headless operation for the NotebookLM CLI integration. Use `true` or `false` according to the installed tool's expectations. |
| `NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` | No | `50` | Positive maximum number of sources uploaded to one NotebookLM notebook. |

The master NotebookLM notebook normally receives the curated source URLs or files rather than the generated Markdown synthesis. If URL ingestion fails and PNIP has stored article Markdown or text, it uploads that stored content as a fallback and records the source failure.

### Digest and discovery behaviour

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DIGEST_MIN_STORIES` | No | `25` | Best-effort minimum story-cluster target. It also drives discovery fill. |
| `DIGEST_DISCOVERY_LOOKBACK_DAYS` | No | `7` | Number of recent days searched for unprocessed entries when the current cursor yields too few items. Set to `0` to disable historical fill. |
| `DIGEST_SOURCE_BALANCE` | No | `true` | When `true`, historical fill prefers articles and YouTube over Reddit. |
| `DIGEST_TARGET_READING_MINUTES` | No | — | Presentation calibration affecting lead-story prominence; it does not remove stories from the canonical digest. |
| `DIGEST_SMALL_EDITION_MAX_DOCUMENTS` | No | internal default | Positive document-count cutoff for using the small-edition clustering policy. |
| `DIGEST_SMALL_EDITION_SIMILARITY_THRESHOLD` | No | internal default | Similarity threshold from `0` to `1` used for small editions. |
| `DIGEST_QUIET_EDITION_REASON` | No | — | Explicit editorial framing: `low_significance` or `low_novelty`. |
| `DIGEST_BIAS_ENABLED` | No | `false` | Set to `true` to apply feedback-derived muted-source suppression and move down-rated stories later. |
| `YOUTUBE_FOCUS_CHANNELS` | No | empty | Comma-separated channel names or handles that receive ranking and deeper transcript-analysis emphasis. |

The minimum story count is a target, not a guarantee. Feed failures, duplicate entries, extraction failures, and clustering cannot be replaced with synthetic stories.

### Queue and worker behaviour

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | No | `4` | Number of concurrent processing workers. Invalid values fall back to `4`; values above `16` are capped at `16`. |
| `RETRY_MAX_ATTEMPTS` | No | `5` | Maximum attempts for processing jobs. Invalid values fall back to `5`; values above `20` are capped at `20`. |
| `PNIP_DRAIN_MAX_JOBS` | No | `100` | Maximum jobs processed by each `digest-drain.sh` tick. This is a script-level setting rather than part of the Zod application schema. |

Transient provider deferrals do not consume a job's retry budget in the same way as permanent processing failures.

### Scheduling and script overrides

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PNIP_PUBLISH_DATE` | No | host's local date | Forces `daily-publish.sh` and the podcast drain to operate on `YYYY-MM-DD`. |
| `PNIP_DRY_RUN` | No | unset | When set, `daily-publish.sh` stops after the publication gate's dry run. |
| `PNIP_LOG_DIR` | No | `<project>/logs` | Overrides the directory used by the publication scripts. |
| `EDITION_SCHEDULE` | No | — | Reserved configuration value. The current runtime does not schedule from it; use cron or another external scheduler. |

## Partition configuration

`PARTITION_CONFIG` is a JSON object keyed by a stable partition name:

```json
{
  "youtube": {
    "category": "YouTube",
    "min_articles": 5,
    "enabled": true,
    "with_podcast": true
  }
}
```

Each partition supports:

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `category` | One selector | — | Case-insensitive Miniflux category title. |
| `category_id` | One selector | — | Positive Miniflux category ID; use instead of `category` when titles may change. |
| `min_articles` | No | `5` | Minimum number of documents required for the partition to become active for an edition. May be `0`. |
| `enabled` | No | `true` | Whether the partition is eligible to become active. |
| `with_podcast` | No | `false` | Whether to generate an optional NotebookLM audio overview for the partition. |

The `master` partition is always active and contains the complete edition. An additional partition becomes active only when it is enabled and reaches its `min_articles` threshold.

Notebook source selection is deterministic and follows story cluster order, document quality, quality confidence, and document ID. Sources above `NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` are recorded as excluded from that notebook but remain part of the edition and Markdown digest.

## Miniflux and Reddit polling

Reddit RSS may reject Miniflux's default User-Agent or throttle a Reddit-heavy collection. A conservative Miniflux configuration is:

```yaml
environment:
  - HTTP_CLIENT_USER_AGENT=PNIP RSS Reader/1.0 (+https://miniflux.example)
  - POLLING_LIMIT_PER_HOST=1
  - POLLING_FREQUENCY=2
  - BATCH_SIZE=1
dns:
  - 1.1.1.1
  - 8.8.8.8
```

The two-minute Miniflux cadence trades freshness for reliability. A large collection may rotate over several hours, which is usually acceptable for a daily digest. Feeds consistently rejected by Reddit's bot protection should be disabled or replaced rather than retried aggressively.

## CLI reference

All commands support `-h` and `--help`. Date arguments default to today where supported.

### Ingestion and publication

| Command | Purpose |
| --- | --- |
| `digestive discover` | Ingest new read or unread Miniflux entries and reset Miniflux read state once per new edition boundary. |
| `digestive process [--date YYYY-MM-DD] [--max-jobs N]` | Drain queued processing jobs, optionally scoped to one edition and bounded to a batch size. |
| `digestive generate-digest` | Render the canonical Markdown digest. |
| `digestive generate-notebook` | Create or resume a NotebookLM notebook. Use `--partition` and `--wait` as needed. |
| `digestive generate-podcast` | Start or resume an optional NotebookLM audio overview. Use `--partition` and `--wait` as needed. |
| `digestive generate-email` | Render and send the HTML email. `--dry-run` skips sending. |
| `digestive generate-edition` | Evaluate the Building → Ready enrichment gate. |
| `digestive publish-edition` | Gate-check and publish the edition. `--dry-run` is read-only. |

### Operations

| Command | Purpose |
| --- | --- |
| `digestive doctor` | Check configuration, PostgreSQL, migrations, queue health, workers, and configured integrations. |
| `digestive metrics` | Show read-only queue, throughput, latency, edition, and partition metrics. |
| `digestive partitions` | Show document counts and recent activity by partition. |
| `digestive active-partitions --date YYYY-MM-DD` | Resolve active partitions for an edition. |
| `digestive retry` | List or requeue failed jobs. Run with `--dry-run` first. |
| `digestive maintenance` | Preview cleanup by default; `--apply` cleans the queue and removes retained edition data. |

### Feedback and source trust

```bash
npm run digestive -- feedback rate <edition_id> <story_id> --up
npm run digestive -- feedback rate <edition_id> <story_id> --down
npm run digestive -- feedback hide <source_url>
npm run digestive -- feedback star <chunk_id>

npm run digestive -- source-trust set <source_identity> <tier> [--notes "..."]
npm run digestive -- source-trust get <source_identity>
npm run digestive -- source-trust list
npm run digestive -- source-trust delete <source_identity>

npm run digestive -- feedback-summary [--edition YYYY-MM-DD]
```

Feedback is self-attributed. With `DIGEST_BIAS_ENABLED=true`, muted sources are suppressed and down-rated stories are moved later in the digest. Source-trust tiers can influence clustering order.

## Retention and maintenance

The installed cron invokes:

```bash
npm run digestive -- maintenance --apply --retention-after 30d
```

This removes edition-linked source data, chunks, enrichment rows, embeddings, generated-artifact rows, discovery events, lineage, old jobs, and associated NotebookLM notebooks after 30 days. Already-downloaded podcast files are outside PostgreSQL retention.

Review and customise this policy before using PNIP as a long-term archive.

## Development

```bash
npm test
npm run typecheck
npm run test:watch
```

Integration tests require `TEST_DATABASE_URL` and PostgreSQL with pgvector. The project has no build step; the CLI runs through `tsx`.

## Project layout

```text
src/cli             Command-line surface
src/config          Environment parsing and partition configuration
src/database        PostgreSQL schema, migrations, and Kysely types
src/discovery       Miniflux client, discovery cursor, and partition routing
src/expansion       Article, YouTube, podcast, PDF, and Reddit plugins
src/chunking        Deterministic chunks and provenance
src/enrichment      Summaries, entities, topics, embeddings, and quality
src/clustering      Story clustering and story summaries
src/editions        Edition lifecycle, readiness, and assembly
src/digest          Markdown, email, NotebookLM, and podcast outputs
src/publication     Publication gate and state transitions
src/signals         Feedback, source identity, bias, and source trust
src/retention       Edition/content and queue cleanup
scripts             Cron and daily-publication helpers
ARCHITECTURE.md     Design decisions and invariants
```

For implementation details and system invariants, see [`ARCHITECTURE.md`](ARCHITECTURE.md).
