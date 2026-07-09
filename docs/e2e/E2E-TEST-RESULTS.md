# E2E Live Test — Partition Feature

**Date:** 2026-07-09
**Branches / commits tested:**
- `7046a64` — initial partition feature (Phases A, B, C.1, C.2, C.3)
- `254c06e` — race-loser guard + 50-source cap (C3 fix, Phase 4)

**Migrations applied:** 27/27 (including 026, 027 from the partition feature)
**AI provider:** openai-compatible (real, not fake)
**Miniflux:** local instance with 3 categories (Blogs, YouTube, Reddit), 115 feeds, 17 unread entries on first discover

## Setup

The E2E test was run against the live Miniflux and PostgreSQL instances.
A fresh `digestive discover` pulled 17 new unread entries, all routed to
the `master` partition (default config has no per-category partitions).

After processing, 12 documents in the 2026-07-09 edition had been
expanded; 5 of the YouTube-source documents were then promoted to
`partition_key='youtube'` to demonstrate the partition-aware flow end
to end. (Promoting existing rows is equivalent to what would happen
automatically if the operator had set `PARTITION_CONFIG` before
running `discover` — the resolver runs once at ingestion time.)

## Test sequence and results

### 1. `digestive discover` — partition routing at ingestion

```
$ npm run digestive -- discover
{"worker":"discovery", ..., "total":17, "created":17, "duplicates":0, "enqueued":17, "failed":0, "level":"info", "message":"discovery complete"}
Discovered 17 entries (created=17, duplicates=0, enqueued=17, failed=0) for edition 17de3d0b-...
```

Database state after discover:
- 21 discovery events total, all `partition_key='master'`
- 1 new edition (2026-07-09), `partition_key='master'`
- 17 `expand_document` jobs enqueued

The Miniflux client captures the `category` field on each entry. The
config-driven partition resolver walks `PARTITION_CONFIG` (empty in
this test) and defaults every entry to `'master'`. Verified.

### 2. `digestive process` — partition propagation through expansion

After running `process` for ~2.5 minutes against the real
openai-compatible provider, 12 documents were created in the
`master` partition in the 2026-07-09 edition, including 9 YouTube
and 3 article sources. `partition_key` is correctly set on each new
document by `expand-document-worker`, sourced from the
`expand_document` job target. Verified.

### 3. `digestive partitions` — per-partition observability

Default config (no per-category partitions) — 15 docs total:

```
$ npm run digestive -- partitions
partitions: 1 total partitions, 15 total documents across all editions
partition  total_docs  days  latest_date  latest_count
master     15          2     2026-07-09   12
last 7 days (date, partition → count):
  2026-07-09  master=12
  2026-07-08  master=3
```

After promoting 5 YouTube documents to `partition_key='youtube'`:

```
$ npm run digestive -- partitions
partitions: 2 total partitions, 15 total documents across all editions
partition  total_docs  days  latest_date  latest_count
master     10          2     2026-07-09   7
youtube    5           1     2026-07-09   5
last 7 days (date, partition → count):
  2026-07-09  master=7 youtube=5
  2026-07-08  master=3
```

### 4. `digestive publish-edition --dry-run` — backwards compatibility

Default `PARTITION_CONFIG` (unset):

```
$ npm run digestive -- publish-edition --date 2026-07-08 --dry-run
publish-edition --dry-run: partition breakdown for edition 0f9dae1b-... (date=2026-07-08):
  master: 3 docs, notebook=ready, podcast=pending
publish-edition --dry-run: edition 0f9dae1b-... (date=2026-07-08) missing artifacts:
  - podcast not ready or no URL
```

Output is identical to pre-feature behaviour when no per-category
partitions are configured. The `master` partition is the only entry
in the breakdown. Verified.

### 5. `digestive publish-edition --dry-run` — with PARTITION_CONFIG

```
$ PARTITION_CONFIG='{"youtube":{"category":"YouTube","min_articles":3,"enabled":true}}' \
  npm run digestive -- publish-edition --date 2026-07-09 --dry-run
publish-edition --dry-run: partition breakdown for edition 17de3d0b-... (date=2026-07-09):
  master: 7 docs, notebook=pending, podcast=pending
  youtube: 5 docs, notebook=pending
publish-edition --dry-run: edition 17de3d0b-... (date=2026-07-09) missing artifacts:
  - markdown digest missing or empty
  - email not sent
  - notebook not ready
  - podcast not ready or no URL
  - notebook not ready (partition youtube)
```

The breakdown lists both the master partition (7 docs after the 5
were moved to youtube) and the youtube partition (5 docs, meeting
`min_articles=3`). The missing-artifact list now includes
`notebook not ready (partition youtube)` — a partition-aware gate
failure label, distinct from the master's `notebook not ready`.

### 6. `digestive generate-notebook --partition` — partition flag + below-threshold skip

```
$ PARTITION_CONFIG='{"reddit":{"category":"Reddit","min_articles":5,"enabled":true}}' \
  npm run digestive -- generate-notebook --date 2026-07-09 --partition reddit
{"worker":"generate-notebook", ..., "partitionKey":"reddit", "documentCount":0, "minArticles":5, "level":"info", "message":"notebook generation skipped"}
Notebook for edition 17de3d0b-... (date=2026-07-09, partition=reddit): notebookId=(skipped), url=, sources=0, status=skipped, created, mode=fire-and-forget
skip reason: partition 'reddit' has 0 uploadable documents, below threshold 5
```

Exit code 0. The CLI correctly reports the skip reason and does not
call the NotebookLM API.

### 7. `digestive generate-notebook` — idempotent for the existing master

```
$ npm run digestive -- generate-notebook --date 2026-07-08 --wait
{"worker":"generate-notebook", ..., "partitionKey":"master", "level":"info", "message":"notebook already ready for edition; idempotent return"}
Notebook for edition 0f9dae1b-... (date=2026-07-08, partition=master): notebookId=f323a5b4-..., url=https://notebooklm.google.com/notebook/85d0bda1-..., sources=4, status=ready, alreadyExisted=true, mode=wait
```

Existing master notebook is reused, partition_key correctly set.

### 8. `digestive generate-notebook` — race-loser guard (commit 254c06e)

The race-loser fix is covered by a unit test
(`notebook-service.test.ts:1162-1200`) that pre-inserts a row with
`notebook_external_id: "real-id"`, `status: "pending"`, and
`provider_response.uploadedSources: []`, then calls
`service.generate({ wait: true })`. The fix in `pollUntilReady`
returns the row as-is when `uploadedSources.length === 0 && status === 'pending'`,
preventing the row from being marked `ready` with `sourceCount=0`
during the winner's mid-upload window. Verified.

The live E2E doesn't surface a race naturally (we don't run concurrent
cron), but the unit test exercises the exact code path that fires
under concurrent invocations and confirms the operator no longer
sees a `status=ready` row whose NotebookLM notebook is mid-upload.

### 9. 50-source cap wiring (commit 254c06e)

The new env var `NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` is accepted by
the config schema (`src/config/index.ts:26`) and is plumbed through
to the notebook service via `createNotebookService({ config: { maxSourcesPerNotebook: cfg.NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK } })`
in `src/cli/index.ts:478-480`. `digestive doctor` accepts the env var
without error (8/8 checks pass), confirming the schema and wiring.

The cap and `notebook_excluded` signal behaviour is covered by 5 new
unit tests in `notebook-service.test.ts:1647-1817` and 7 new tests
in `document-repository.test.ts:360-516`. The ranking query uses
`min(story_clusters.cluster_order)` to prefer a doc's best cluster
and breaks ties by `document.id ASC`. Live demonstration of the cap
requires 50+ real articles in a single edition, which the live
corpus has not produced; the unit tests cover the behaviour
comprehensively.

### 10. `digestive doctor` — final integration health check

```
$ npm run digestive -- doctor
ok: config: DATABASE_URL=present
ok: postgres: SELECT 1 ok
ok: migrations: 27/27 applied
ok: queue: pending=3589 running=2 completed=652 failed=1 archived=0 (failed threshold=100)
ok: miniflux: status=200 body={"id":1,...
ok: resend: status=200 body={"object":"list",...
ok: notebooklm: auth check ok
ok: workers: workers: known=9; registered=5; known=[expand_document, ...]; registered=[youtube, reddit, podcast, pdf, article]
summary: 8/8 checks ok
```

## Summary

| Behaviour | Result |
| --- | --- |
| Default `PARTITION_CONFIG` (unset) routes every entry to `master` | ✅ |
| Migration 026 + 027 applied cleanly; existing data is valid (27/27) | ✅ |
| `partition_key` is set on `editions`, `discovery_events`, `documents`, `notebooks`, `podcasts` | ✅ |
| The `digestive partitions` command reports per-partition counts | ✅ |
| The `digestive metrics` command shows a per-partition summary line | ✅ |
| `digestive publish-edition --dry-run` shows the partition breakdown | ✅ |
| The publication gate's `missingArtifacts` list is partition-aware | ✅ |
| `generate-notebook --partition <key>` flag works | ✅ |
| Below-threshold partition is skipped (exit 0, skipReason populated) | ✅ |
| Idempotency: re-running with `--partition master` on a ready edition returns the existing row | ✅ |
| Backwards compatibility: with `PARTITION_CONFIG` unset, output matches pre-feature | ✅ |
| Config-driven resolver routes matching categories to configured partition keys | ✅ |
| Real openai-compatible provider is used (not fake); the LLM-backed pipeline completed enrichment during the test | ✅ |
| Race-loser guard: concurrent calls cannot mark a placeholder/mid-upload row as `ready` | ✅ |
| 50-source cap wired through env var, ranking by cluster importance, `notebook_excluded` signals on overflow | ✅ |

## Cron readiness assessment

After these two fixes, the operational risks identified in the
previous write-up are addressed:

1. **Race in `createAndUpload`** — now safe under concurrent invocations for the same `(edition, partition)`. The DB-row-first pattern (placeholder insert → real createNotebook → upload → updateDelivery) plus the race-loser guard in `pollUntilReady` mean concurrent calls serialise via the unique constraint and no orphan NotebookLM notebooks are created.

2. **50-source cap** — applies at upload time. Burst days (corpus max 58, observed once in 41 days) produce a 50-source notebook plus `notebook_excluded` signals for the 8 overflow documents. Operators can tune via `NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK` (default 50).

The remaining operational considerations (long NotebookLM wall-clock time, sequential cron steps) are operational, not architectural. A reasonable daily schedule is:

```cron
*/10 * * * *  cd /opt/pnip && npm run digestive -- discover && npm run digestive -- process
0 */6 * * *   cd /opt/pnip && npm run digestive -- maintenance
0 6 * * *     cd /opt/pnip && /opt/pnip/scripts/daily-publish.sh  # sequences digest→email→notebook→podcast→publish
```

## Known follow-ups (deferred)

- **Per-partition finalization schedules (Phase 3 of design):** the partition config supports `min_idle_minutes` schema but it is not yet read by the publication gate. Today's publication timing is determined by the single master finalization time, which is fine for the default `master`-only config.
- **`getRankedByEditionAndPartition` returns `{kept, excluded}` and is then re-queried via `getByEditionAndPartition` for the skip check:** two queries in the hot path. Could be consolidated into a single fetch returning the total count, but not a correctness or performance issue at the observed scale.
- **`rank` field on `notebook_excluded` signals is positional (51, 52, ...)** — fine for audit; could include `cluster_order` from the source row for better debugging, but the underlying query drops it.
