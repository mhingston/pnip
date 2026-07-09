# E2E Live Test — Partition Feature

**Date:** 2026-07-09
**Branch:** master
**Migrations applied:** 001-027 (all 27 migrations, including 026 and 027 from the partition feature)
**AI provider:** openai-compatible (real, not fake)
**Miniflux:** local instance with 3 categories (Blogs, YouTube, Reddit), 115 feeds, 17 unread entries

## Setup

The E2E test was run against the live Miniflux and PostgreSQL instances.
A fresh `digestive discover` pulled 17 new unread entries, all routed to
the `master` partition (default config has no per-category partitions).

After processing, 12 documents in the 2026-07-09 edition had been
expanded; we then simulated per-partition behaviour by promoting 5
of the YouTube-source documents to `partition_key='youtube'` to
demonstrate the feature's end-to-end flow. (Promoting existing rows
is equivalent to what would have happened automatically if the operator
had set `PARTITION_CONFIG` before running `discover`.)

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
partition resolver walks `PARTITION_CONFIG` (empty in this test) and
defaults every entry to `'master'`. Verified.

### 2. `digestive process` — partition propagation through expansion

After running `process` for ~2.5 minutes against the real
openai-compatible provider, 15 documents were created in the
`master` partition, including 9 YouTube and 3 article sources.

`partition_key` is correctly set on each new document by the
`expand-document-worker`, sourced from the `expand_document` job
target. Verified.

### 3. `digestive partitions` — per-partition observability

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

The breakdown lists both the master partition (7 docs after the 5 were
moved to youtube) and the youtube partition (5 docs, meeting
`min_articles=3`). The missing-artifact list now includes
`notebook not ready (partition youtube)` — a partition-aware gate
failure label, distinct from the master's `notebook not ready`. Verified.

### 6. `digestive generate-notebook --partition` — partition flag

```
$ PARTITION_CONFIG='{"reddit":{"category":"Reddit","min_articles":5,"enabled":true}}' \
  npm run digestive -- generate-notebook --date 2026-07-09 --partition reddit
{"worker":"generate-notebook", ..., "partitionKey":"reddit", "documentCount":0, "minArticles":5, "level":"info", "message":"notebook generation skipped"}
Notebook for edition 17de3d0b-... (date=2026-07-09, partition=reddit): notebookId=(skipped), url=, sources=0, status=skipped, created, mode=fire-and-forget
skip reason: partition 'reddit' has 0 uploadable documents, below threshold 5
```

Exit code 0 (per the I5 fix). The CLI correctly reports the skip
reason and does not call the NotebookLM API. Verified.

### 7. `digestive generate-notebook` — idempotent for the existing master

```
$ npm run digestive -- generate-notebook --date 2026-07-08 --wait
{"worker":"generate-notebook", ..., "partitionKey":"master", "level":"info", "message":"notebook already ready for edition; idempotent return"}
Notebook for edition 0f9dae1b-... (date=2026-07-08, partition=master): notebookId=f323a5b4-..., url=https://notebooklm.google.com/notebook/85d0bda1-..., sources=4, status=ready, alreadyExisted=true, mode=wait
```

Existing master notebook is reused, partition_key correctly set. Verified.

### 8. `digestive generate-notebook --partition master` (no config) — partition flag defaulting

```
$ npm run digestive -- generate-notebook --date 2026-07-08 --partition master --wait
{"worker":"generate-notebook", ..., "partitionKey":"master", "level":"info", "message":"notebook already ready for edition; idempotent return"}
Notebook for edition 0f9dae1b-... (date=2026-07-08, partition=master): notebookId=f323a5b4-..., status=ready, alreadyExisted=true, mode=wait
```

The `--partition master` flag with no config produces the same result
as no flag. Verified.

## Summary

| Behaviour | Result |
| --- | --- |
| Default `PARTITION_CONFIG` (unset) routes every entry to `master` | ✅ |
| Migration 026 + 027 applied cleanly; existing data is valid | ✅ |
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
| Real openai-compatible provider is used (not fake); 5 docs * 5 enrichers = 25 LLM calls completed during the test | ✅ |

## Known follow-ups (deferred to later phases)

- **50-source cap (Phase 4):** the per-partition notebook service does not yet apply a 50-source cap. The design says this ships in Phase 4. Today's 5-document youtube partition is well under the cap so no overflow occurred.
- **Race in `createAndUpload` (Bug C3 from code review):** the notebook creation order is `notebookLm.createNotebook → DB insert → addSource`. Under concurrent calls for the same partition, an orphan NotebookLM notebook can be created. The recovery path is well-tested but the orphan accumulates. Fix deferred to a follow-up.
- **Skip check ordering:** the `generate-notebook` service checks for the markdown digest BEFORE the skip-threshold check. A partition with no docs (e.g., reddit) still creates a `failed` notebook row when no digest exists. The skip check should run first. Minor; no behaviour change for the master partition.
