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

## Status

Milestones **M0–M13** are complete (`877/877` tests pass against the
project's Postgres test database; `tsc --noEmit` is clean).

| Milestone | Phase                              | Status      |
| --------- | ---------------------------------- | ----------- |
| M0        | Foundation & infrastructure        | Complete    |
| M1        | Discovery Worker / Events          | Complete    |
| M2        | Expansion & Canonical Documents    | Complete    |
| M3        | Chunking                           | Complete    |
| M4        | AI Enrichment                      | Complete    |
| M5        | Story Clustering                   | Complete    |
| M6        | Edition Assembly & Lifecycle       | Complete    |
| M7        | Markdown Digest                    | Complete    |
| M8        | HTML Email                         | Complete    |
| M9        | NotebookLM notebook                | Complete    |
| M10       | NotebookLM podcast                 | Complete    |
| M11       | Publication                        | Complete    |
| M12       | CLI & Operations                   | Complete    |
| M13       | Testing & Hardening (§61 audit)    | Complete    |

The full implementation specification — architecture, data model,
milestones, and acceptance criteria — is at [`docs/PLAN.md`](docs/PLAN.md).

## Prerequisites

| Component       | Required for                         | Notes                                   |
| --------------- | ------------------------------------ | --------------------------------------- |
| PostgreSQL 14+  | the database                         | `pgvector` extension (auto-installed)   |
| Miniflux        | `digestive discover`                 | an account + API token                  |
| Resend          | `digestive generate-email`           | an API key + verified sender domain     |
| `notebooklm-py` | `generate-notebook` / `generate-podcast` | the CLI must be on `$PATH` and `auth check --test --json` must succeed |
| Fabric (optional)| article / youtube / pdf / reddit extraction | only needed for live content extraction |
| An AI provider  | enrichment + summaries               | OpenAI, an OpenAI-compatible gateway, or `AI_PROVIDER=fake` for offline dev |

## Quick start

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env
# edit .env: set DATABASE_URL, MINIFLUX_*, RESEND_API_KEY, EMAIL_FROM, ...

# 3. run the database migrations (automatic on every command, but explicit here)
npx tsx src/cli/index.ts process --help   # any command runs migrations first

# 4. confirm connectivity
npx tsx src/cli/index.ts doctor
# expect: summary: 8/8 checks ok

# 5. seed today's edition, discover fresh items, drain the queue
npx tsx src/cli/index.ts discover
npx tsx src/cli/index.ts process

# 6. generate the day's outputs (Markdown → email → NotebookLM → podcast)
npx tsx src/cli/index.ts generate-digest  --date $(date +%F)
npx tsx src/cli/index.ts generate-email   --date $(date +%F)
npx tsx src/cli/index.ts generate-notebook --date $(date +%F) --wait
npx tsx src/cli/index.ts generate-podcast  --date $(date +%F) --wait

# 7. publish
npx tsx src/cli/index.ts publish-edition --date $(date +%F)
```

All commands also work via `npm run digestive -- <command> ...`.

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
not set)"` when their config is absent.

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
completed.

Tuning notes:

- Discovery is idempotent (dedupe by URL + edition); over-polling is
  harmless but wasteful. Align with Miniflux's refresh interval.
- `process` runs to queue-empty in a single invocation, so a short
  interval × short-lived process is fine.
- Maintenance is idempotent and bounded; the daily `--apply` is the real
  cleanup; dry-run previews are cheap and useful for surfacing
  regressions in queue growth.

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
| `LOG_LEVEL`               | optional   | `debug` / `info` / `warn` / `error` (default `info`)       |

## Development

```bash
npm test                 # full vitest suite (877 tests)
npm run test:watch       # vitest in watch mode
npm run typecheck        # tsc --noEmit
```

Integration tests need `TEST_DATABASE_URL` pointing to a live Postgres
with the `pgvector` extension available; without it, the integration
suites auto-skip (518 unit tests still run).

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
    queue/              # ProcessingJobQueue — claim/complete/cancel/listFailed/requeue
    workers/            # generic Worker runtime + claim/execute/persist contract
  discovery/            # Miniflux client + DiscoveryService
  expansion/            # ExpansionPlugin + plugins (article, youtube, podcast, pdf, reddit)
  canonical/            # canonical document model
  chunking/             # deterministic chunk boundaries + provenance
  enrichment/           # 5 workers (summary, entities, topics, embeddings, quality)
  clustering/           # story clustering + summarize_story
  editions/             # Edition lifecycle, assembly, readiness gate, M6/M7/M8/M11/M13 audits
  digest/
    markdown/           # Markdown digest service + citation renderer
    html/               # Markdown→HTML renderer, Resend client, email template
    notebooklm/         # NotebookLM + Podcast services (fire-and-forget)
  publication/          # M11 PublicationService — completion gate + state transition
  prompts/              # prompt_versions repository + default-prompt seeding
  provenance/           # lineage graph + citation resolution
  ai/                   # provider abstraction + vercel / openai-compatible / fake
  common/               # JSON extraction + vector codec
docs/
  PLAN.md               # full implementation specification (§1–§65)
```

Every domain directory exposes a well-defined public interface;
cross-domain dependencies flow only through repositories, never via
direct SQL.

## Pointers

- **Full specification** — [`docs/PLAN.md`](docs/PLAN.md) covers §1
  architecture, §15–§38 pipeline + data model, §39–§53 edition lifecycle
  + publication, §54–§64 operations + delivery, and the implementation
  milestones M0–M13.
- **Milestone status blocks** — each milestone in `docs/PLAN.md` has a
  `Status: ✅ Complete (2026-07-07)` block with a Delivered /
  Architecture notes / Known technical debt breakdown.
- **§61 acceptance criteria** — exercised by
  `src/editions/m13-acceptance.test.ts` (12 `itWithDb` tests mapping to
  the 20 criteria). The audit runs against a real Postgres with every
  external service mocked; it auto-skips without `TEST_DATABASE_URL`.

## Known technical debt (v1)

- **Synchronous publication** — `digestive publish-edition` runs the
  gate check + DB updates in a single CLI call; the runtime is short so
  the fire-and-forget UX is fine for v1. A future iteration could make
  it a worker.
- **Cooperative job cancellation** — `cancelForEdition` runs an UPDATE;
  in-flight jobs run to completion and self-terminate at the next
  `isProcessingAllowed` check. A future iteration could expose a
  `cancelled` flag in the claim response so long-running workers can
  abort early.
- **No `runtime.listRegisteredWorkers()`** — the `doctor` workers
  check prints the static known-worker list. A future iteration could
  expose the live registered set.
- **§65 Signal-to-Noise and Feedback** — a deliberately deferred
  four-phase rollout (capture-only → CLI ingest → read-only ranking
  hints → feedback-aware re-ranking) that should start with Phase A only
  once the rss-digest project's `editorial_profile.md` is being
  compared against PNIP digests in practice. See `docs/PLAN.md` §65 for
  the full plan.