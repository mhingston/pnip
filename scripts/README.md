# scripts/

Ad-hoc operator scripts for the `digestive` pipeline. These are not part of the
test suite and are intentionally not run in CI.

## Cron-driven scripts

PNIP does not ship a scheduler; recurring commands are scheduled by the
operator (cron, systemd timer, launchd, etc.). The `cron-install.sh` helper
installs the recommended schedule into the user's crontab in one step.

### `digest-drain.sh`

Drains new Miniflux entries into PNIP and processes them. Designed to run
on a tight cron (every 5–15 minutes) throughout the day. Both `discover`
and `process` are idempotent, so overlapping or duplicate runs are safe.

Logs to stdout; cron appends the output to `logs/digest-drain.log`.

```bash
*/10 * * * *  /opt/pnip/scripts/digest-drain.sh >> /opt/pnip/logs/digest-drain.log 2>&1
```

### `daily-publish.sh`

Sequences the daily publication for the operator's local-timezone edition.
Reads `PARTITION_CONFIG` from `.env` and produces a master notebook (and
master podcast) plus, for any configured partition that meets its
`min_articles` threshold, a per-partition notebook.

Sequence:

1. `digestive generate-digest --date <local-today>` (master)
2. Resolve active partitions with the database-backed `enabled` +
   `min_articles` rule, then fire-and-forget `generate-notebook` for every
   active partition.
3. `--wait` on every active partition's notebook, then start podcasts only
   after their corresponding notebooks are ready. Podcast generation remains
   asynchronous because podcasts are optional and must not block publication.
4. `digestive generate-email --date <local-today>` after required notebook
   artifacts are ready.
5. Evaluate edition readiness and run `publish-edition --dry-run` (gate check).
6. `digestive publish-edition --date <local-today>` (real publish).

### `podcast-drain.sh`

Runs every 10 minutes by default. It resolves the active partitions for the
local edition date and attempts `generate-podcast --wait`; the podcast service
checks that the notebook status is `ready` before making any audio-generation
request. A pending notebook is retried later; a generating podcast resumes its
existing NotebookLM artifact rather than starting a duplicate.

Environment overrides:
- `PNIP_PUBLISH_DATE=YYYY-MM-DD` — publish a specific date instead of today
- `PNIP_DRY_RUN=1` — stop after the dry-run gate check
- `PNIP_LOG_DIR=/path/to/logs` — override the log directory

```bash
0 6 * * *  /opt/pnip/scripts/daily-publish.sh >> /opt/pnip/logs/daily-publish.log 2>&1
```

### `cron-install.sh`

Installs, removes, or shows the PNIP cron block in the current user's
crontab. The block is tagged `# pnip-managed` so removal is precise and
other cron entries are untouched. Idempotent.

```bash
# Install with the default schedule
scripts/cron-install.sh install

# Customise the publication time
scripts/cron-install.sh install --schedule-publish "30 5 * * *"

# Customise the drain interval
scripts/cron-install.sh install --schedule-drain "*/15 * * * *"

# Show the installed block
scripts/cron-install.sh show

# Remove
scripts/cron-install.sh remove
```

Default schedule:

| Cron expression     | Script                  | Purpose                                  |
| ------------------- | ----------------------- | ---------------------------------------- |
| `*/10 * * * *`      | `digest-drain.sh`       | Drain Miniflux → editions                |
| `*/10 * * * *`      | `podcast-drain.sh`      | Resume ready NotebookLM podcasts         |
| `0 */6 * * *`       | (inline)                | Queue cleanup + 30-day retention purge   |
| `0 6 * * *`         | `daily-publish.sh`      | Daily publication at 06:00 local         |

All entries use the system clock's local time. The `daily-publish.sh`
script uses the local date as the edition date; the operator can override
with `PNIP_PUBLISH_DATE`.

The script also installs a `logs/` subdirectory if it doesn't exist, so
the redirect targets are valid on first install.

## Helpers

### `load-env.mjs`

Loads the project `.env` via `dotenv` and prints `export KEY=VALUE` lines
that bash can `eval`. Used by the cron scripts to source env vars
without the risk of bash mishandling values that contain angle brackets
or other shell-meaningful characters (notably `EMAIL_FROM`).

## One-shot drivers

### `m6-e2e-driver.ts`

End-to-end driver for the M6 (Edition Assembly & Lifecycle) code path on a live
database. Demonstrates the full M6 flow end-to-end without depending on the
external `fabric` / AI providers:

1. Seeds fake enrichment rows (summaries, entities, topics, embeddings,
   quality_classifications) for every document in the edition.
2. Resets the edition's `cluster_stories_enqueued_at` claim and the
   `document_enrichment_status` tracker.
3. Calls `EnrichmentGateService.markEnrichmentDoneAndMaybeEnqueueCluster` for
   each document, observing that the gate returns `null` until the **last**
   document's final enrichment completes, then returns the
   `{ jobType: "cluster_stories", ... }` payload **exactly once**.
4. Creates a story and its summary directly (the live `cluster_stories` and
   `summarize_story` workers are tested in the unit suite; the M6 logic
   exercised here is the gate + readiness transition + state guard).
5. Reads readiness via `EditionAssemblyService.getReadiness`.
6. Drives the `building → ready` transition via
   `EditionReadinessGate.transitionToReadyIfReady`.
7. Verifies the state guard (`isProcessingAllowed(ready) === false`).
8. Re-renders the full `EditionAssemblyService.assemble(editionId)` snapshot.

To run against a live database:

```bash
set -a; . /path/to/pnip.env; set +a
./node_modules/.bin/tsx scripts/m6-e2e-driver.ts
```

The script hard-codes the edition id it targets; update `editionId` in
`main()` before running against a different edition.

### `demo-gate-fire.ts`

Replays the enrichment-tracker + gate sequence against enrichments that were
actually produced by the real LLM (via `process`). Useful for validating the
`building → ready` claim atomicity outside the full CLI run.

Run only after `process` has produced at least one document's worth of
real-LLM enrichment rows; the script does not seed fake data. It re-marks the
tracker from scratch and demonstrates that calling the gate for the final
enrichment of the last document fires `cluster_stories` exactly once.
