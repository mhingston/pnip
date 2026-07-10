# PNIP — Personal News Intelligence Pipeline

A self-hosted TypeScript application that turns content discovered from RSS
feeds into a curated daily intelligence product: a canonical Markdown
digest, an HTML email delivered via Resend, a NotebookLM notebook, and a
NotebookLM-generated podcast.

Miniflux acts solely as the discovery mechanism. Once an item is
discovered and successfully persisted, all subsequent processing happens
inside PNIP. The pipeline is built from independent, resumable,
idempotent stages; every generated artifact carries complete provenance
back to the original source chunks; every Edition becomes immutable after
publication.

The project also includes a self-attributed feedback loop: the operator
can rate stories, mute sources, and star chunks, and (optionally) have
the digest apply that feedback as a deterministic re-ordering or have
the clusterer re-rank by a hand-curated source-trust tier.

## Status

Milestones **M0–M13** are complete, all four phases of the §65
Signal-to-Noise rollout have shipped, and the partition-key feature
(notebook editions per Miniflux category) has shipped for Phases A, B,
and C (`1165/1165` tests pass against the project's Postgres test
database; `tsc --noEmit` is clean). A real end-to-end run has been
verified against live Miniflux, Resend, and NotebookLM.

| Milestone / Phase                       | Status   |
| --------------------------------------- | -------- |
| M0 Foundation & infrastructure          | Complete |
| M1 Discovery Worker / Events            | Complete |
| M2 Expansion & Canonical Documents      | Complete |
| M3 Chunking                             | Complete |
| M4 AI Enrichment                        | Complete |
| M5 Story Clustering                     | Complete |
| M6 Edition Assembly & Lifecycle         | Complete |
| M7 Markdown Digest                      | Complete |
| M8 HTML Email                           | Complete |
| M9 NotebookLM notebook                  | Complete |
| M10 NotebookLM podcast                  | Complete |
| M11 Publication                         | Complete |
| M12 CLI & Operations                    | Complete |
| M13 Testing & Hardening (§61 audit)     | Complete |
| §65 Phase A — passive signal capture   | Complete |
| §65 Phase B — feedback CLI             | Complete |
| §65 Phase C — bias views + opt-in re-ordering | Complete |
| §65 Phase D — source-trust re-ranking  | Complete |
| Partition-key Phases A, B, C — `partition_key` column, partition resolver, per-partition notebook + podcast, publication gate | Complete |
| Partition-key Phase 4 — 50-source cap + per-source quality ranking + overflow signals | Complete |
| Partition-key Phase 3 — per-partition finalization schedules | Deferred |

The full implementation specification — architecture, data model,
milestones, and acceptance criteria — is at [`docs/PLAN.md`](docs/PLAN.md).
**1188/1188 tests pass.**

## Prerequisites

| Component        | Required for                              | Notes                                                       |
| ---------------- | ----------------------------------------- | ----------------------------------------------------------- |
| PostgreSQL 14+   | the database                              | `pgvector` extension (auto-installed)                       |
| Miniflux         | `digestive discover`                      | an account + API token                                      |
| Resend           | `digestive generate-email`                | an API key + verified sender domain                         |
| `notebooklm-py`  | `generate-notebook` / `generate-podcast`  | the CLI must be on `$PATH` and `auth check --test --json` must succeed |
| Fabric (optional)| article / youtube / pdf / reddit extraction | only needed for live content extraction                |
| An AI provider   | enrichment + summaries                    | OpenAI, an OpenAI-compatible gateway, or `AI_PROVIDER=fake` for offline dev |

## Quick start

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env
# edit .env: set DATABASE_URL, MINIFLUX_*, RESEND_API_KEY, EMAIL_FROM, ...

# 3. run the database migrations (automatic on every command, but explicit here)
npm run digestive -- process --help   # any command runs migrations first

# 4. confirm connectivity
npm run digestive -- doctor
# expect: summary: 8/8 checks ok

# 5. seed today's edition, discover fresh items, drain the queue
npm run digestive -- discover
npm run digestive -- process

# 6. generate the day's outputs (Markdown → email → NotebookLM → podcast)
npm run digestive -- generate-digest   --date $(date +%F)
npm run digestive -- generate-email    --date $(date +%F)
npm run digestive -- generate-notebook --date $(date +%F) --wait
npm run digestive -- generate-podcast  --date $(date +%F) --wait

# 7. publish
npm run digestive -- publish-edition --date $(date +%F)

# 8. (optional) inspect the day's signal data
npm run digestive -- metrics
```

All commands also work via `npx tsx src/cli/index.ts <command> ...`.

## CLI command reference

Every command supports `-h` / `--help` for full flags. Exit codes: `0` on
success, `1` on operational failure, `2` on flag-parsing errors.

### Day-to-day

| Command                         | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `digestive discover`            | Pull unread entries from Miniflux and persist as `DiscoveryEvent` |
| `digestive process`             | Drain the internal job queue (workers run until empty)            |
| `digestive generate-digest`     | Render the canonical Markdown digest for the edition               |
| `digestive generate-email`      | Render the HTML email from Markdown and send via Resend            |
| `digestive generate-notebook`   | Create the NotebookLM notebook (fire-and-forget by default)        |
| `digestive generate-podcast`    | Kick off the NotebookLM podcast (fire-and-forget by default)       |
| `digestive publish-edition`     | Gate-check the four artifacts and transition Ready → Published     |

`generate-notebook` / `generate-podcast` accept `--wait` to block until
the remote service finishes (10–20 min for podcasts). `generate-email`
accepts `--dry-run` to render + report without sending. `publish-edition`
accepts `--dry-run` to gate-check without mutating state.

### Operational

| Command                         | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `digestive doctor`              | Read-only diagnostics: PG, migrations, queue, external APIs        |
| `digestive metrics`             | §58 internal metrics: queue depth, throughput, latency, edition publication duration |
| `digestive retry`               | List and requeue failed jobs (filters: edition, worker, age, limit) |
| `digestive maintenance`         | Bound `processing_jobs` growth (archive completed/failed, purge)   |
| `digestive generate-edition`    | Evaluate the Building → Ready transition in isolation              |

`retry` filters: `--edition-id <uuid>`, `--worker <jobType>` (alias
`--job-type`), `--older-than <duration>` (suffixes `s`/`m`/`h`/`d`),
`--limit <n>` (default 1000, max 10 000), `--dry-run`.

`maintenance` flags: `--apply`, `--archive-after <duration>` (default
`1d`), `--purge-after <duration>` (default `7d`), `--limit <n>` (default
10 000). Without `--apply` it runs in dry-run preview mode.

`doctor` checks: `config`, `postgres`, `migrations`, `queue`,
`miniflux` (`GET /v1/me`), `resend` (`GET /domains`), `notebooklm`
(`auth check --test --json`), and `workers` (known vs registered).
Optional integrations report `ok=true` with `detail="skipped (config
not set)"` when their config is absent. The queue check's failed-job
threshold defaults to 100 and is configurable via
`DOCTOR_FAILED_THRESHOLD`.

`metrics` reports queue depth (pending / running / completed / failed /
archived), total retries, max retries, avg processing latency,
throughput (last hour / last day), oldest pending age, and edition
metrics (total / by status, published count, avg publication duration,
last published timestamp, oldest building age).

### Feedback loop (§65)

| Command                                                    | Purpose                                          |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `digestive feedback rate <edition_id> <story_id> [--up\|--down]` | Write a `story_up` or `story_down` signal  |
| `digestive feedback hide <source_url>`                     | Write a `source_muted` signal (derives the `source_identity` for the URL — see below) |
| `digestive feedback star <chunk_id>`                       | Write a `chunk_starred` signal                   |
| `digestive source-trust set <source_identity> <tier> [--notes ...]` | Set the trust tier (1–5) for a source identity |
| `digestive source-trust get <source_identity>`             | Print the trust tier for a source                |
| `digestive source-trust list`                              | Print all trust rows                             |
| `digestive source-trust delete <source_identity>`          | Remove a trust row                               |
| `digestive feedback-summary [--edition YYYY-MM-DD] [--source-identity <key>] [--limit n]` | Read-only aggregate of `signals` for an edition (per-kind counts + top muted sources / voted stories / starred chunks) |

**Source identity** is the normalized grouping key written alongside
`source_url` in every signal. It is derived by a pure deterministic
function so that all sources that should be grouped together share a
key:

- `article` / `pdf` → hostname (strip `www.`, keep subdomains)
- `reddit` → `reddit.com/r/{subreddit}` (extracted from the URL path)
- `youtube` → `youtube.com/channel:{id}` (from `metadata.author_url`)
- `podcast` → `podcast:{publisher}` (from the publisher column)

§65 Phase A writes signals passively from the clusterer, digest
service, and summarize-story worker. Phase B provides the CLI surface
above. Phase C (opt-in via `DIGEST_BIAS_ENABLED=true`) drops stories
whose every document is from a muted source and moves down-rated
stories out of Top Stories. Phase D re-orders clusters by the
`source_trust` tier when the worker loads the trust table.

## Per-partition notebook editions

The partition feature shipped across several phases. The `partition_key`
column, the resolver, the per-partition notebook + podcast pipeline, the
publication gate, the 50-source cap, and the per-source quality ranking
are all in. The deferred item is per-partition finalization schedules
(Phase 3 of the design doc), which would let each partition have its
own `finalization_time` and `min_idle_minutes` instead of inheriting
the master's. The current model is "master time-of-day, per-partition
notebook" — sufficient for the master-only default and the simple
per-category case the operator is most likely to use.

**What partitions are.** Each Miniflux entry carries a
`partition_key` derived from its feed's Miniflux category. By default
every entry routes to the `master` partition, which produces one
NotebookLM notebook per day containing all of the edition's documents
— identical to pre-feature behaviour. When the operator sets
`PARTITION_CONFIG`, per-category partitions can be enabled; each
enabled partition produces its own NotebookLM notebook alongside the
master one. See *How a partition's top sources are picked* below for
the rule that decides which documents make it into each notebook.

**Backwards compatibility.** With `PARTITION_CONFIG` unset (or set to
an empty JSON object) every entry goes to `master`, the master
notebook is the only one produced, and the publication gate behaves as
it always has. There is no migration step for existing operators and no
behavioural change without opting in.

**Enabling a partition.** `PARTITION_CONFIG` is a JSON object keyed by
partition name. Each entry takes an optional `category` (Miniflux
category title, case-insensitive) or `category_id` (numeric ID), an
optional `min_articles` threshold (default 5), an optional `enabled`
flag (default `true` if the entry exists), and an optional
`with_podcast` flag. The `master` partition is always active and never
subject to a `min_articles` threshold — below-threshold and disabled
non-master partitions are silently suppressed.

Example: a YouTube-only notebook with a podcast, plus a Reddit-only
notebook without one, leaving the master notebook as the always-on
catch-all:

```bash
PARTITION_CONFIG='{"youtube":{"category":"YouTube","min_articles":5,"enabled":true,"with_podcast":true},"reddit":{"category":"Reddit","min_articles":3,"enabled":true}}'
```

**Per-partition commands and flags.**

| Command                                                         | Purpose                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `digestive partitions`                                          | Read-only per-partition report: total documents, distinct days, latest edition date and count, plus a per-day breakdown for the last 7 days |
| `digestive generate-notebook [--partition <key>]`               | Generate the NotebookLM notebook for one partition (default `master`)  |
| `digestive generate-podcast [--partition <key>]`                | Generate the NotebookLM podcast for one partition (default `master`; only meaningful if `with_podcast=true`) |
| `digestive publish-edition --dry-run`                           | Now prints a per-partition breakdown (master plus each configured partition) showing documents, notebook readiness, and podcast readiness |
| `digestive metrics`                                             | Adds a `partitions: <key>=<docs> ...` summary line                      |

When `PARTITION_CONFIG` is set, `publish-edition` gates on every
**active** partition (master plus each non-master partition whose
document count meets `min_articles`): each must have a ready
notebook, and if `with_podcast=true` it must also have a ready
podcast, before the edition transitions to Published.

### How a partition's top sources are picked

Each partition notebook has a hard cap on the number of sources it
uploads. The cap is **per `(edition, partition)` pair** — the master
partition and the youtube partition each get their own top 50 (or
whatever the cap is set to). Within one partition, the 50 (or fewer)
documents uploaded to NotebookLM are chosen by a deterministic four-key
sort, applied in order:

1. **Cluster importance** — `MIN(story_clusters.cluster_order)` for the
   document's clusters. Cluster 0 is the top story and ranks first;
   higher cluster orders rank later. Documents not in any cluster
   rank after all clustered documents.
2. **Per-source quality label** — `MIN(CASE label WHEN 'high' THEN 1
   WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END)` across the
   document's `quality_classifications` rows. A document with any
   high-rated chunk ranks as `high`. Documents with no quality rows
   rank last within their cluster (treated as unclassified).
3. **Per-source quality confidence** — `AVG(quality_classifications.confidence)`.
   Ties in label rank break on this; higher confidence wins. Ties
   here fall through to the final key.
4. **Document id** — `documents.id ASC`. Deterministic and stable but
   not semantic; this is a UUID tiebreak.

The cap is **50 by default**, overridable via the
`NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` env var. When a partition has
more documents than the cap, the overflow is silently dropped from
the notebook (the master markdown digest is unaffected — it is
generated from the full edition). One `notebook_excluded` signal is
written per excluded document so the operator can audit what was
dropped:

```sql
SELECT payload
FROM signals
WHERE edition_id = :edition
  AND signal_kind = 'notebook_excluded'
ORDER BY (payload->>'rank')::int;
```

Each row's payload includes:

- `partition_key` — which partition the drop occurred on
- `reason` — `source_cap` (today the only reason)
- `cap` — the configured cap (so the operator can reproduce)
- `total_documents` — partition size at the time of selection
- `rank` — the 1-indexed position in the partition's full ranked list
  (the first excluded is `rank = cap + 1`)

In practice the cap is rarely hit. The corpus sample peaks at
~58 articles in a single day distributed across categories; a single
partition reaching 50 would be a rare burst day. The picking order
above is what the operator can rely on when it does fire.

## Recommended operations cadence

PNIP does not ship a scheduler; recurring commands are scheduled by the
operator (cron, systemd timer, launchd, etc.).

```text
every 5–15 min:   digestive discover && digestive process          # drain Miniflux → editions
every 6h:         digestive maintenance            (dry-run preview by default)
daily (after publication): digestive maintenance --apply
```

Edition publication itself is a separate trigger — a cron around the
desired publish time calling `digestive publish-edition --date
<YYYY-MM-DD>` after `generate-digest`, `generate-email`,
`generate-notebook --wait`, and `generate-podcast --wait` have all
completed. When per-category partitions are enabled, the
`generate-notebook` and `generate-podcast` calls need to be issued
once per active partition (the `--partition <key>` flag selects which
one; the default is `master`). A convenient pattern is to call them
per partition key after `digestive partitions` has reported which
partitions are active for the day, or to drive the loop from the
publication report's partition breakdown.

Tuning notes:

- Discovery is idempotent (dedupe by URL + edition); over-polling is
  harmless but wasteful. Align with Miniflux's refresh interval.
- `process` runs to queue-empty in a single invocation, so a short
  interval × short-lived process is fine.
- Maintenance is idempotent and bounded; the daily `--apply` is the real
  cleanup; dry-run previews are cheap and useful for surfacing
  regressions in queue growth.
- `metrics` is a read-only snapshot — safe to run from cron. Useful for
  alerting on queue depth, tracking publication duration over time, or
  watching the `partitions: ...` summary line to spot a partition that
  has gone quiet.
- `partitions` is also read-only and safe from cron; useful as a
  morning check that the expected per-category notebook will actually
  fire today.

## Environment

Configuration is environment-driven; see `.env.example` for the full
list. The application validates the config on startup and fails fast if
anything required is missing.

| Variable                  | Required   | Purpose                                                    |
| ------------------------- | ---------- | ---------------------------------------------------------- |
| `DATABASE_URL`            | yes        | PostgreSQL connection string                               |
| `TEST_DATABASE_URL`       | tests only | separate Postgres for the integration test suite           |
| `MINIFLUX_URL`            | discover   | base URL of the Miniflux instance                          |
| `MINIFLUX_API_TOKEN`      | discover   | Miniflux API token                                         |
| `RESEND_API_KEY`          | email      | Resend API key                                             |
| `EMAIL_FROM`              | email      | verified sender address                                    |
| `EMAIL_RECIPIENT`         | email      | one or more recipients (comma / semicolon / space sep.)    |
| `AI_PROVIDER`             | enrichment | `openai` (default), `openai-compatible`, or `fake`         |
| `OPENAI_API_KEY`          | AI         | OpenAI / OpenAI-compatible API key                         |
| `OPENAI_BASE_URL`         | optional   | override the OpenAI-compatible base URL                    |
| `AI_TEXT_MODEL`           | optional   | text model name (default: `gpt-4o-mini`)                   |
| `EMBEDDING_MODEL`         | optional   | ONNX model (default: `Xenova/all-MiniLM-L6-v2`, 384-dim)    |
| `EMBEDDING_CACHE_DIR`     | optional   | local cache for the embedding model                        |
| `NOTEBOOKLM_OUTPUT_DIR`   | optional   | directory for downloaded podcast mp3s (default `./notebooks`) |
| `FABRIC_BIN`              | optional   | path to the Fabric CLI                                     |
| `MARKITDOWN_BIN`          | optional   | path to the MarkItDown CLI                                 |
| `DIGEST_BIAS_ENABLED`     | optional   | `true` to apply §65 Phase C bias (muted-source drop + down-rated move); default off |
| `DIGEST_TARGET_READING_MINUTES` | optional | positive integer that calibrates Top Stories prominence; never removes canonical stories or sources. Unset keeps the five-story newspaper default |
| `DIGEST_QUIET_EDITION_REASON` | optional | explicit editorial evidence: `low_significance` or `low_novelty`. Unset emits no quiet-day claim |
| `PARTITION_CONFIG`        | optional   | JSON object mapping partition keys to `{category, min_articles, enabled, with_podcast}`; see *Per-partition notebook editions* above. Unset = master-only default |
| `NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` | optional | integer 1+; hard cap on sources uploaded per partition notebook. Default 50. Overflow gets `notebook_excluded` signals. See *How a partition's top sources are picked* above |
| `DOCTOR_FAILED_THRESHOLD` | optional   | integer 1+; `digestive doctor` fails the queue check when `failed > N` (default 100) |
| `LOG_LEVEL`               | optional   | `debug` / `info` / `warn` / `error` (default `info`)       |

## Development

```bash
npm test                 # full vitest suite (1188 tests)
npm run test:watch       # vitest in watch mode
npm run typecheck        # tsc --noEmit
```

Integration tests need `TEST_DATABASE_URL` pointing to a live Postgres
with the `pgvector` extension available; without it, the integration
suites auto-skip and the unit-only subset still runs.

The project is plain Node + TypeScript — no bundler, no codegen. Build
artefacts are produced on demand by `tsx` for the CLI entry point.

## Project structure

```
src/
  cli/                  # command surface (parse*Flags + run*Command + *HELP)
  config/               # env-driven configuration + zod validation
  logging/              # structured JSON logger
  database/             # pool, migrations (forward-only, transactional)
  jobs/
    queue/              # ProcessingJobQueue — claim/complete/cancel/listFailed/requeue/getMetrics
    workers/            # generic Worker runtime + claim/execute/persist contract
  discovery/            # Miniflux client + DiscoveryService + PartitionResolver
  expansion/            # ExpansionPlugin + plugins (article, youtube, podcast, pdf, reddit)
  canonical/            # canonical document model
  chunking/             # deterministic chunk boundaries + provenance
  enrichment/           # 5 workers (summary, entities, topics, embeddings, quality)
  clustering/           # story clustering + summarize_story
  editions/             # Edition lifecycle, assembly, readiness gate, M6/M7/M8/M11/M13 audits
  digest/
    markdown/           # Markdown digest service + citation renderer + §65 bias application
    html/               # Markdown→HTML renderer, Resend client, email template
    notebooklm/         # NotebookLM + Podcast services (fire-and-forget), partition-aware
  publication/          # M11 PublicationService — completion gate + state transition, per-partition
  signals/              # §65 signal capture: source-identity, signal-repository, bias-view, source-trust
  prompts/              # prompt_versions repository + default-prompt seeding
  provenance/           # lineage graph + citation resolution
  ai/                   # provider abstraction + vercel / openai-compatible / fake
  common/               # JSON extraction + vector codec
docs/
  PLAN.md               # full implementation specification (§1–§66)
  DESIGN-notebook-generation-pipeline.md  # notebook-pipeline design + phased rollout status
```

Every domain directory exposes a well-defined public interface;
cross-domain dependencies flow only through repositories, never via
direct SQL.

## Pointers

- **Full specification** — [`docs/PLAN.md`](docs/PLAN.md) covers §1
  architecture, §15–§38 pipeline + data model, §39–§53 edition lifecycle
  + publication, §54–§64 operations + delivery, §65 signal-to-noise,
  §66 partition key, and the implementation milestones M0–M13.
- **Notebook pipeline design** — [`docs/DESIGN-notebook-generation-pipeline.md`](docs/DESIGN-notebook-generation-pipeline.md)
  captures the architectural decisions behind per-partition notebooks:
  the partition axis, the master-only default, the per-partition
  publication gate, the 50-source cap with cluster-importance + per-
  source quality ranking, and the deferred per-partition schedules
  (Phase 3).
- **Milestone status blocks** — each milestone in `docs/PLAN.md` has a
  `Status: ✅ Complete` block with a Delivered / Architecture notes /
  Known technical debt breakdown.
- **§61 acceptance criteria** — exercised by
  `src/editions/m13-acceptance.test.ts` (12 `itWithDb` tests mapping to
  the 20 criteria). The audit runs against a real Postgres with every
  external service mocked; it auto-skips without `TEST_DATABASE_URL`.
- **§65 signal-to-noise** — covered in `docs/PLAN.md` §65. Phase A is
  passive (signals written from workers). Phase B is the
  `digestive feedback` CLI. Phase C is opt-in via
  `DIGEST_BIAS_ENABLED=true`. Phase D is opt-in via
  `source_trust` rows.
- **§66 partition key** — covered in `docs/PLAN.md` §66. The
  `partition_key` column on `editions`, `discovery_events`,
  `documents`, `notebooks`, and `podcasts` is the join key for the
  per-category notebook publication path. With `PARTITION_CONFIG` unset
  the operator sees no behavioural change; with it set, each configured
  partition produces its own NotebookLM artifact. The `digestive
  partitions` command and the `--partition <key>` flag on
  `generate-notebook` / `generate-podcast` are the operator surfaces.
