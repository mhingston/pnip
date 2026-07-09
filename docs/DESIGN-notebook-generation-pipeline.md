# Design — Notebook Generation Pipeline

**Status:** Phases A, B, C.1, C.2, C.3 implemented (1165 tests pass). The 50-source cap (Phase 4) and per-partition finalization schedules (Phase 3) are deferred. · **Audience:** the operator (Mark) and any future implementation PR · **Date:** 2026-07-08

This document captures what we learned from the live Miniflux instance, what
shape notebook editions should take, and how PNIP should feed them. It is
**not** an implementation plan for code; it is an architectural decision
record. Implementation belongs to a separate task.

---

## 0. TL;DR

1. **The current Miniflux corpus is one topic in three buckets.** All 115
   feeds are AI-related. The three Miniflux categories (Blogs, Reddit,
   YouTube) are not different *topics* — they are different *formats*. They
   carry largely redundant signal.
2. **No single category on its own justifies a dedicated daily edition.**
   Median daily volume is **5 blogs / 1 Reddit thread / 7 YouTube videos**.
   Even the busiest day in the sample (2026-06-16, the 6-16 Reddit burst)
   produced 47 Reddit articles, well under the 50-article notebook ceiling.
3. **The right primary unit is still a *calendar-day edition***, but we
   should *partition* each daily edition by Miniflux category and let the
   operator **opt-in per category** to "notebook this partition as its own
   NotebookLM notebook". Default: one master edition + one master notebook
   per day (no change from today). The partition axis is purely an
   **output** choice; the underlying edition is still one per day.
4. **Ingestion stays continuous (every 5–15 min).** The current
   `discover && process` cadence is already idempotent and the corpus is
   small enough to redrain cheaply. No new event-bus is needed.
5. **Finalization is daily**, time-of-day is per-partition (defaults below
   in §6), and the operator can override per-partition.
6. **Quiescent partitions and burst overflow are handled by rules**, not by
   human attention: a partition with `< min_articles` is not published as a
   standalone notebook (it folds into the master notebook); a partition with
   `> 50` articles keeps the top 50 by cluster quality and lets the rest
   drift to the next day in Miniflux (the discover loop is what catches
   them).

The design is intentionally additive. It does not require a migration
beyond adding a `partition_key` column to `editions` and a `partition`
notebook map; everything else is configuration.

---

## 1. Findings from Miniflux

### 1.1 Inventory (snapshot 2026-07-08)

| Metric            | Value     |
| ----------------- | --------- |
| Total entries     | 12 066    |
| Unread entries    | 8         |
| Read entries      | 12 058    |
| Removed entries   | 0         |
| Total feeds       | 115       |
| Categories        | 3         |
| Miniflux timezone | UTC       |
| User              | `admin`   |

| Category | Feeds | % of corpus |
| -------- | ----- | ----------- |
| Blogs    | 20    | 17 %        |
| Reddit   | 59    | 51 %        |
| YouTube  | 36    | 31 %        |

* Source: `GET /v1/feeds` (2026-07-08).
* Every single feed in the corpus is **AI-related**. The three categories
  are organized by *source type* (long-form prose, threaded discussion,
  video), not by *topic*. They are not three editorial verticals.

### 1.2 Volume distribution

The dataset is 2 000 most-recent read entries (≈ 41 days of history:
2026-05-28 → 2026-07-08). Of those, 1 253 land on 2026-05-28 → 2026-05-30,
which is clearly a **one-off historical import into Miniflux** (every
single feed in the corpus shows `last_fetched_at = null`, so the import
itself is what made the corpus appear). We treat those three days as a
**bulk-import artifact** and exclude them from the steady-state stats
below. The remaining 747 entries span **39 days** ("normal period").

| Category | Days sampled | Mean/day | Median | P25 | P75 | Min | Max | Stddev | Days = 0 | Days ≥ 20 |
| -------- | -----------: | -------: | -----: | --: | --: | --: | --: | -----: | -------: | --------: |
| Blogs    |           39 |     5.79 |      5 |   2 |   8 |   1 |  15 |   4.38 |        0 |         0 |
| Reddit   |           39 |     3.95 |      1 |   0 |   3 |   0 |  47 |   8.71 |       13 |         2 |
| YouTube  |           39 |     9.41 |      7 |   4 |  13 |   1 |  26 |   6.76 |        0 |         4 |
| **All**  |       **39** | **19.15** | **18** | **11** | **23** | **3** | **58** | **11.40** | **0** | **18** |

* Source: `/v1/entries?status=read&limit=1000` × 2 pages, then 39-day
  slice.
* The full distribution: 90 % of normal days carry between 3 and 32
  articles, well within the 50-article ceiling for any single notebook.
* YouTube is the **highest-yield, most predictable** feed of content:
  it has never been empty, and it is the category that most often clears
  the 10-article-per-day bar.
* Reddit is the **burstiest and emptiest** category: 13 of 39 days have
  zero Reddit articles, but 2 days exceeded 20, and the maximum was 47
  (all from a single sub, `r/vibecoding`).
* Blogs is the **most boring** category: a tight 1–15 band, ~6 articles
  per day, no zeros, no spikes.

### 1.3 Daily cadence (organic arrival)

Median inter-arrival between two consecutive articles of the same category:

| Category | Median | Min     | Max           |
| -------- | -----: | ------: | ------------: |
| Blogs    |  124 m |   < 1 m |     32.0 h    |
| Reddit   |   46 m |   < 1 m |    109.0 h    |
| YouTube  |   64 m |   < 1 m |     32.6 h    |

The median gap is **under two hours** for every category. Hourly ingestion
is more than sufficient; 5–15-minute ingestion (today's cadence) is
overkill but harmless because discovery is idempotent and the queue
drains to empty.

### 1.4 Burst behaviour

Two kinds of burst exist in the data:

1. **Bulk historical import** (5-28 → 5-30, 1 253 articles). Every Reddit
   feed except 5 went silent immediately after the import — the 5
   that continued posting are the only ones with normal-period activity.
   * 42 of 47 Reddit feeds in the sample have content **only** in the
     bulk-import period. Implication: 89 % of the Reddit feeds have
     produced **no signal** in the 39 days since the import. They are
     dead-or-quiet and should probably be unsubscribed (operator
     decision, not the pipeline's), but the pipeline must not break if
     they are not.
2. **Organic bursts** (6-15 → 6-16 Reddit, 26 → 47 articles). The 6-16
   spike came almost entirely from `r/vibecoding` (32 articles) and
   `r/VibeCodersNest` (5 articles). The total still fit a single
   notebook comfortably (47 < 50).

### 1.5 Day-of-week pattern (overall, normal period)

| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
| --: | --: | --: | --: | --: | --: | --: |
| 175 | 158 | 104 | 113 |  69 |  53 |  75 |

Mon/Tue are the heaviest (3–4× the weekend rate). Fri/Sat are the
lightest. A weekend-skippable per-partition finalization is worth
offering but is not load-bearing.

### 1.6 Time-of-day pattern (UTC, normal period)

Articles by hour-of-day (UTC) are spread across all 24 hours. Localised
peaks at 00h, 12–13h, 16h, 23h; troughs at 02–05h and 21–22h. There is
**no single "right" finalization time** that minimises missed articles,
and the spread (83 % of articles published ≥ 06:00 UTC, 6 % in the
22:00–23:59 window) means any daily cutoff will lose a small fraction
of late-evening content. That is acceptable as long as the lost content
is picked up by the **next** day's discover loop (see §4.3).

### 1.7 What the existing PNIP code already does

For context, the current pipeline (`src/discovery/discovery-service.ts`,
`src/editions/edition-repository.ts`) already implements everything we
need for the *time-window* half of the design:

* `DiscoveryService.discover({ editionDate })` fetches unread Miniflux
  entries and persists a `DiscoveryEvent` per entry, attributed to a
  single Edition for that date. The entry's `publishedAt` is recorded
  on the event but is **not** used to route the event to a different
  edition — the edition is the operator-supplied `editionDate`.
* The EditionRepository enforces `UNIQUE (publication_date)` on editions
  (`003_create_editions.sql`), so "one edition per day" is the schema
  constraint today.
* `notebooks` (`022_create_notebooks.sql`) is `UNIQUE (edition_id)` —
  one notebook per edition. The notebook service uploads **every**
  document in the edition as a source (see
  `notebook-service.ts:287`), plus the rendered Markdown digest as one
  extra source.
* `EDITION_SCHEDULE=0 6 * * *` exists in `.env.example` as an
  operator-facing hint, but the pipeline does not run it.

The **partition** half of the design is new. The schema changes are
small (one column, one join table) and reversible.

---

## 2. Definitions

* **Edition** — the unit that PNIP produces per publication period. The
  state machine is unchanged (`building → ready → publishing →
  published`; §39 of `docs/PLAN.md`). After this design, an edition
  still has one date, one status, and one set of documents.
* **Partition** — a named slice of an edition. The default and only
  partition initially is `master`. New partitions are added by
  configuration, one per Miniflux category the operator wants to surface
  as a separate notebook.
* **Notebook edition** — the output artifact for a (publication date,
  partition) pair: one NotebookLM notebook, one podcast if enabled. For
  the `master` partition this is identical to today's notebook. For a
  category partition, it is a NotebookLM notebook containing only the
  documents of that category.
* **Master edition** — the historical single-edition-per-day output,
  unchanged. Today's `daily.md`, today's `daily.html`, today's
  `notebook_external_id`. Existing operators see no behaviour change
  unless they opt in.
* **Miniflux category** — the upstream bucket. We never *rename* or
  *restructure* Miniflux categories; we just map them to partitions
  in the PNIP config.

---

## 3. What should define a notebook edition?

### 3.1 Option analysis

| Option                                 | Verdict | Reason |
| -------------------------------------- | ------- | ------ |
| **One edition per Miniflux category**  | ❌ Reject | Categories are not editorial verticals. Splitting one daily edition into three would create three thin, largely-overlapping digests and force re-clustering per category. With medians of 5/1/7, two of three partitions would frequently be "interesting" only as appendices to the master. |
| **One edition per topic**              | ❌ Reject | The corpus is single-topic. Topic detection per article adds cost without a topic-axis to spread across. |
| **Time-window only** (today's model)   | ✅ Default | The corpus is small, organic, and time-localised. One edition per day is what operators already reason about. |
| **Time-window × Miniflux category**    | ✅ Opt-in | Preserves the master edition. Lets the operator request "give me a YouTube-only notebook" without forcing it on others. |
| **Time-window × cluster** (a notebook per story) | ❌ Reject | Cluster count varies wildly; notebook upload cost is paid per call. |
| **Rolling (e.g., 6-hour) windows**     | ❌ Reject for now | The corpus averages 19 articles/day; a 6-hour window averages 5, which is below the cost of a fresh notebook (≥ 10–20 sources is the lower bound for useful NotebookLM). |

### 3.2 Recommendation

**Time-window × Miniflux category, default partition = `master`, opt-in
per-category partitions.** Concretely:

* The base Edition lifecycle (§39) is unchanged. One Edition per day.
* Each document in the edition is tagged with a `partition_key` derived
  from its feed's Miniflux category (`master` by default; `category:2 →
  blogs`; `category:3 → youtube`; `category:4 → reddit`; new categories
  get a partition too, default partition `master` again).
* A partition is **active** for a given day if and only if it has at
  least `min_articles` documents *and* the operator enabled that
  partition in config. The default config enables only `master`.
* For each active partition, PNIP produces a notebook. The master
  partition always produces one. A disabled or below-threshold
  partition does not.

This keeps the **operator's mental model identical to today** ("today's
edition") while giving them a per-category escape hatch when they want
it.

### 3.3 The 50-article ceiling

The task says notebook editions can include up to **≈ 50 source
articles**. Looking at the data, the master edition is the only thing
that has *ever* come close (58 articles on 6-16, a Reddit burst day),
and even that is well within an order of magnitude. A per-category
notebook has *never* exceeded 50 articles in the sample.

The concrete rules:

* `MAX_SOURCES_PER_NOTEBOOK = 50` (configurable, hard upper bound
  enforced at notebook-service layer).
* If a partition exceeds 50, we keep the **top 50 by cluster
  importance** (story cluster size × cluster-quality-score, the same
  metric M5 already uses). The rest stay in the edition as documents
  but are **not** uploaded to that day's notebook.
* Overflow documents are *not* discarded. They are recorded as
  `notebook_excluded` signals (§65 substrate, no behaviour change) and
  will be re-evaluated on the next day. The Miniflux entry stays marked
  read (the master edition's content is still complete and the article
  was real for the day); the operator can find the article in the
  Markdown digest even though it didn't make the notebook.
* For the **master** partition, the 50 cap is softer. The Markdown
  digest and email already include the full content; only the
  notebook upload is capped. The trade-off is documented in §7.

---

## 4. How frequently should new Miniflux articles be ingested into an in-progress edition?

### 4.1 Recommendation: continuous, 5–15 minutes, as today

* Discovery is already idempotent (URL+edition dedupe in
  `discovery-repository.ts:46`).
* The corpus is small (~19 articles/day organic; ~25K/year at current
  rates). A 5-minute `discover && process` run adds < 2 new events on
  average.
* `process` drains the queue to empty in a single invocation, so a
  short interval × short-lived process is fine and the queue never
  grows unbounded under healthy operation.
* The 50-article ceiling (§3.3) gives us a hard cap on the worst-case
  cost of an over-eager ingest; even 200 events/day for the master
  partition would not blow it.

### 4.2 Why not event-driven?

* Miniflux has webhooks, but the operator already runs
  `digestive discover` on a timer. Adding a webhook receiver means a
  new long-running process and a new failure surface.
* The "event-driven" framing is misleading anyway. An "event" in
  Miniflux is a new entry appearing in a feed; that is a once-per-feed-
  per-refresh notification, not a per-article event. The net effect
  would be the same as a tight polling loop, with worse failure
  properties.
* Webhook retries and authentication would be a non-trivial
  operational add. Defer until we have a concrete need.

### 4.3 What about late-arriving content?

PNIP discovery uses the operator-supplied `editionDate` (default
"today") to choose the target edition (`discovery-service.ts:38`). This
is the right behaviour for a daily finalization model: a Miniflux
article that shows up late still belongs to *the day it was
discovered*, not the day it was published upstream. Late-evening
articles that arrive after the 06:00 UTC finalization simply land in
**the next day's** edition. (The Markdown digest for the day they were
discovered is already frozen; the article is read in Miniflux; the
article appears in the *next* day's digest instead. This is acceptable
because the corpus is dominated by evergreen AI commentary rather than
breaking news.)

If a hard "same-day, no exceptions" rule is later desired, the design
accommodates it cleanly: an additional `finalized_at` field on the
edition, a per-edition "re-open" command, and a discovery-time check
that prefers the *most recent* edition in `building` state rather than
*the date*. That's a phase-3 addition, not phase-1.

---

## 5. When should an edition be considered complete and finalized?

### 5.1 Recommendation: daily finalization, per-partition, configurable

* The **master** edition finalizes at a single operator-configured
  time-of-day (default 06:00 UTC, matches today's `EDITION_SCHEDULE`).
  Finalization = transition `building → ready → publishing → published`
  per §41 of PLAN.
* **Category partitions** may set their own finalization time, but the
  default is the same as the master edition. The two should not
  finalize in *opposite orders* — if Blogs finalizes first, the master
  (which includes Blogs) has to wait. The simplest rule: **the master
  edition's finalization time is the upper bound for every partition
  in that day.** A partition can choose to finalize earlier (e.g.,
  04:00 UTC for YouTube) and let the rest of the day be spent on the
  master, but it cannot finalize later.
* An active partition is finalized iff:
  1. The master edition is in `building` state, and
  2. The partition's `min_articles` threshold is met, and
  3. The partition's `min_idle_minutes` (no new events) is met
     **OR** the master edition's finalization time has arrived
     (whichever comes first).
* The `min_idle_minutes` rule is the operator's "wait for the last
  article to land" knob. Default 30 minutes. YouTube has tight
  inter-arrival, so 30 min is generous; Reddit is bursty, so 30 min
  may want to be 60–120 min for that partition specifically.

### 5.2 Why not "ready when nothing has changed in N minutes"?

We considered an event-driven finalizer ("the edition is ready when
no new discovery events have arrived in N minutes and we are past
08:00 UTC"). It is technically attractive but operationally tricky:

* The "N" is different for each partition and changes as feeds churn.
* Late-evening content would sometimes finalize a master edition at
  23:00, which makes the email/notebook arrive at midnight — not what
  the operator wants.
* The deterministic "fixed time of day" answer is what the operator
  can schedule in cron and reason about. We keep that as the default
  and add `min_idle_minutes` as a *secondary* trigger, not a
  replacement.

### 5.3 What about `min_idle_minutes` and bursts?

If 5 articles land at 05:55 UTC and then 5 more land at 06:01 UTC,
`min_idle_minutes=30` would defer finalization to 06:31. The 5
latecomers are included; the trade-off is that the operator's email
arrives 31 minutes later. We accept this; it is the price of waiting
for "the last article". A future phase could expose
`max_idle_minutes` (a hard upper bound that overrides `min_idle`)
to guarantee finalization by, say, 07:00 UTC. That's an operator
config knob, not a behaviour change.

---

## 6. Edge cases

| Situation | Handling |
| --- | --- |
| **Partition has 0 articles** | Partition is not active that day. The master edition may still contain zero articles from that category — that's fine, the Markdown digest has no section for it (existing §43 behaviour). No notebook is created. Logged. |
| **Partition has 1–`min_articles-1` articles** | Same as above. Default `min_articles = 5`. The articles are still in the master edition and the master notebook; the partition notebook is suppressed. |
| **Partition has exactly 50 articles** | The full partition is uploaded. No overflow handling needed. |
| **Partition has 51+ articles** | Keep the top 50 by cluster importance, log exclusions, leave the rest in the master edition's documents (so they appear in the Markdown digest). The partition notebook still uploads; the article count is bounded. |
| **Bulk import** (Miniflux imports 1 000+ historical entries at once) | Today's behaviour already handles this: discovery is idempotent, the queue drains, and the resulting edition is enormous. We do **not** special-case bulk imports — the operator controls this by either (a) marking the entries as read in Miniflux before running discover, or (b) accepting the resulting master edition. The 50-cap on the per-partition notebook *does* protect the per-partition notebook from the worst-case bulk import, but the master edition's notebook is still at risk. **This is a known limitation** (see §7). |
| **Long quiet period (3+ days with no content in a category)** | Nothing to do. PNIP produces master editions with no YouTube / no Reddit / no Blogs section as appropriate. The operator can investigate via `digestive doctor` and the existing per-feed health checks. |
| **Burst of activity (single feed produces 50 articles in a day)** | If the burst feed is in its own partition, that partition hits the 50-cap and overflows into the master edition's documents only (not the master notebook, see §7). If the burst feed is in the `master` partition (the default), the 50-cap is *not* applied to the master notebook; the documents are still in the edition and in the digest, but only the top 50 by cluster importance get uploaded. This matches today's behaviour, just with a bounded cap. |
| **Miniflux feed changes category** | The discovery service already records the feed_id on `DiscoveryEvent`. Partition resolution is a per-event lookup at the time of ingestion, not at finalization, so a feed that moves categories retroactively re-resolves. (Migrations of past editions are out of scope.) |
| **Miniflux is unreachable mid-day** | `discover` and `process` already handle this (existing failure-recovery in §50). The edition stays in `building`; the next successful run continues. Finalization is the operator's decision once the queue is drained. |

---

## 7. Risks and trade-offs

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Master edition notebook can still exceed 50 sources on a bulk-import day (since the master partition's notebook isn't capped) | Low (last seen 2026-05-29) | High — NotebookLM may reject or silently truncate | Phase 1: log a warning; Phase 2: enforce a soft 100-source hard cap on the master notebook with overflow shown only in the Markdown digest. The Markdown is the canonical archive, the notebook is a convenience. |
| Per-category partitions are not editorial verticals; they will overlap heavily in topics | High | Medium — operator may turn on YouTube partition and find the same 3 stories re-clustered into both YouTube and master notebooks | Document explicitly in the partition config: "partitions are not editorial verticals". Default the config to `master`-only. |
| The 50-source cap on a partition notebook will silently drop content the operator cared about | Medium | Medium — operator sees a smaller notebook than the data warrants | (a) `notebook_excluded` signal row per dropped source; (b) `digestive notebook-status` reports the exclusion count; (c) the dropped sources still appear in the Markdown digest for the same day. |
| Miniflux category is a brittle routing key. Operator reorganizes → historical editions are unaffected but future ones are | Low | Low | Resolve partition at ingestion time, not at finalization. Document the operator-facing rule "moving a feed's category does not retroactively change its historical edition's partition." |
| NotebookLM upload cost: one notebook per active partition per day. If 3 categories are enabled, we triple the per-day notebook cost | High if opted in | Low — NotebookLM has no per-call cost, but the operator's wall-clock time and the NotebookLM quota go up | Make the partition config explicit, document the cost, default to master-only. |
| "min_idle_minutes" can stretch finalization past the scheduled time indefinitely if a feed keeps posting | Low | Low — the operator's email/notebook is late | Add a `max_idle_minutes` override in a follow-up. |
| Splitting the master edition into partitions means we now have N+1 notebook artifacts per day to gate-check on publication | Low | Low | The publication completion gate (§49) already iterates over the artifacts of *one* edition. We extend it to iterate over the artifacts of *one edition × active partitions*. No state machine change. |

### Trade-offs the design explicitly accepts

* **We accept that a per-category notebook is not an editorial
  vertical.** It is a *format* cut, and we use it as such. The corpus
  is too small and too single-topic to support more granular
  partitioning.
* **We accept that some content will be in the master edition's
  Markdown digest but not in any notebook on a 50-cap day.** The
  Markdown is the canonical archive; the notebook is a convenience
  artifact for Q&A. Losing 6-16-style bursts from the master notebook
  is acceptable; losing them from the digest would not be.
* **We accept that the `master` partition is always active.** It is
  the "everything" partition. There is no operator config to disable
  it. If the operator wants to opt out of notebooks entirely, that is
  a different code path (turn off the notebook CLI command), not a
  partition config.

---

## 8. Alternatives considered and rejected

### 8.1 Generate one notebook per story cluster

* **Idea:** After clustering, create one notebook per top-N cluster,
  each notebook containing the sources of that cluster.
* **Why rejected:** NotebookLM is a *corpus* tool; a 1-story notebook
  is a single Q&A target with no context. The corpus-quality threshold
  (≥ 10–20 sources) is not met per cluster. The upload cost is paid N
  times for marginal utility. The digest already groups stories
  cluster-by-cluster; a per-cluster notebook adds nothing the digest
  doesn't.

### 8.2 Ingest on Miniflux webhook (event-driven)

* **Idea:** Subscribe to Miniflux's outgoing webhook, ingest per
  article event.
* **Why rejected:** Webhooks are per-refresh, not per-article, so the
  granularity claim is false. We add a long-running process, a
  receiver, and a new failure surface for an end result equivalent to
  polling every 5 minutes. Defer until we have a concrete reason.

### 8.3 Finalize on "no events in N minutes" (event-driven finalization)

* **Idea:** Edition is ready when no new discovery events have arrived
  in N minutes, after a configurable lower bound (e.g., 08:00 UTC).
* **Why rejected:** It is harder to schedule in cron, harder to reason
  about for the operator, and produces non-deterministic finalization
  times that complicate the email/notebook cadence. We keep
  finalization as a fixed time of day, with `min_idle_minutes` as a
  soft secondary trigger.

### 8.4 Merge all three categories into one big `master` partition forever

* **Idea:** Don't add the partition axis at all. Keep one master
  edition per day, one master notebook per day.
* **Why not:** This is the default. The partition axis is **additive**:
  the operator gets the master behaviour for free and turns on
  partitions only when they want to. We include the partition axis in
  the design because the task explicitly asks for it, and because we
  expect the operator to want a "videos only" notebook once they see
  YouTube's 9-articles-per-day volume.

### 8.5 Rolling 6-hour windows

* **Idea:** Finalize an edition every 6 hours, getting 4
  editions/notebooks per day.
* **Why rejected:** The corpus averages 19 articles/day; a 6-hour
  window averages 5. Below the useful-notebook threshold and
  quadrupling the upload cost. Could be revisited if the corpus grows
  5–10×.

---

## 9. Workflow: an article from Miniflux to a published notebook edition

```text
       ┌─────────────────────────────────────────────────────────────┐
       │  Miniflux                                                   │
       │  (corpus of 115 feeds, 3 categories, ~19 articles/day)      │
       └────────────────────────┬────────────────────────────────────┘
                                │ unread entries
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  discover  (every 5–15 min, operator-scheduled)             │
       │  - fetch unread entries                                     │
       │  - resolve partition_key from feed.category                 │
       │  - persist DiscoveryEvent                                   │
       │  - enqueue expand_document                                  │
       │  - mark entry as read in Miniflux                           │
       └────────────────────────┬────────────────────────────────────┘
                                │ queue
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  process  (queue drain)                                     │
       │  - expand → canonical doc → chunk → enrich → cluster        │
       │  - per-doc enrichment tracker (M6)                          │
       └────────────────────────┬────────────────────────────────────┘
                                │ last document enriched
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  enrichment gate → cluster_stories                          │
       │  - one cluster_stories job per edition (NOT per partition)  │
       │  - clusters are computed on the full edition's chunks       │
       └────────────────────────┬────────────────────────────────────┘
                                │ stories
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  per-partition assembly                                     │
       │  - for each active partition: select documents              │
       │  - select top 50 by cluster importance                      │
       │  - if min_articles unmet: skip partition                    │
       └────────────────────────┬────────────────────────────────────┘
                                │ partition manifests
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  publication pipeline (per active partition)                │
       │  - master: markdown → html → email → notebook → podcast     │
       │  - partition: notebook (and podcast if enabled)             │
       │  - master publication is the gate: no partition publishes   │
       │    until master's markdown exists                           │
       └────────────────────────┬────────────────────────────────────┘
                                │ artifacts persisted
                                ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  publish-edition  (operator command, gates all partitions)  │
       │  Ready → Publishing → Published                             │
       └─────────────────────────────────────────────────────────────┘
```

### Per-article decision points

* **Ingestion** (`discover`): the only routing decision is
  `partition_key` resolution from the feed's Miniflux category. This
  is deterministic and computed once.
* **Enrichment / clustering**: unchanged. The full edition is enriched
  and clustered as one. Per-partition document selection happens
  *after* clustering.
* **Per-partition assembly**: filter edition documents by
  `partition_key`, rank by cluster importance, apply the 50-source
  cap.
* **Per-partition publication**: for each active partition, run the
  subset of the §42 publication pipeline that produces its
  artifacts. Master is the superset.
* **Gating**: `publish-edition` is called once per day. It checks the
  master artifacts first; if the master is `ready`, it iterates over
  the active partitions and validates each. All partitions transition
  in lockstep (`building → ready → publishing → published`).

---

## 10. Architecture (ASCII)

```text
+----------------------+      +------------------+      +----------------+
|  Miniflux (UTC)      |      |  Operator Cron   |      |  PNIP          |
|                      |      |                  |      |                |
|  115 feeds           |      |  5-15 min:       | ---> |  discover      |
|  3 categories        |      |    discover &&   |      |  process       |
|  ~19 articles/day    |      |    process       |      |                |
|                      |      |                  |      |                |
|                      |      |  06:00 UTC:      | ---> |  publish-      |
|                      |      |    publish-      |      |  edition       |
|                      |      |    edition       |      |                |
+----------------------+      +------------------+      +-------+--------+
                                                                 |
                                                                 v
                                              +-----------------------------+
                                              | PostgreSQL                  |
                                              |                             |
                                              |  editions                   |
                                              |    + partition_key (NEW)    |
                                              |  discovery_events           |
                                              |    + partition_key (NEW)    |
                                              |  documents                  |
                                              |    + partition_key (NEW)    |
                                              |  story_clusters (per ed.)   |
                                              |  markdown_digests (1/ed)   |
                                              |  email_digests (1/ed)      |
                                              |  notebooks (NEW: 1/partition)|
                                              |  podcasts (1/partition)     |
                                              |  signals (NEW: notebook_   |
                                              |    excluded for overflow)   |
                                              +-----------------------------+
                                                                 |
                                                                 v
                                              +-----------------------------+
                                              |  External                   |
                                              |    - Resend                 |
                                              |    - NotebookLM (notebooks, |
                                              |      podcasts)              |
                                              |    - AI provider            |
                                              +-----------------------------+
```

---

## 11. Phased implementation plan (no code, just sequencing)

The design is **additive** — every phase is shippable in isolation and
reversible by toggling config.

### Phase 0 — Read-only instrumentation (no behaviour change)

* Add `partition_key` column to `editions`, `discovery_events`, and
  `documents` (default `'master'`).
* At ingestion time, compute `partition_key` from the feed's Miniflux
  category and persist it.
* At finalization time, report per-partition counts via
  `digestive metrics` (read-only).
* New CLI: `digestive partitions` lists configured partitions and
  their article counts for the day.

**Acceptance:** running `discover && process` produces identical
output. `digestive partitions` shows counts.

### Phase 1 — Master-only with per-partition observability (no notebook change)

* All documents still go to the master edition.
* `digestive metrics` exposes per-partition counts in
  `editions.partition_article_counts` (computed column or view).
* Operator can see "today has 7 YouTube articles and 5 Blogs articles"
  without anything changing downstream.

**Acceptance:** operator can opt-in or opt-out of partition tracking
via config without affecting publication.

### Phase 2 — Per-partition notebook (opt-in)

* New config: `PARTITION_CONFIG = { blogs: { enabled: true,
  min_articles: 5 }, youtube: { enabled: true, min_articles: 8,
  min_idle_minutes: 30 } }`.
* Add `partition_key` to `notebooks` (no longer UNIQUE on
  `edition_id`); new `UNIQUE (edition_id, partition_key)`.
* Extend `notebook-service` to take a partition. Partition selection
  happens in the publication pipeline.
* Extend `publish-edition` to gate on all active partitions.
* Default config: all categories disabled, master enabled (no
  behaviour change vs today).

**Acceptance:** with one category enabled, that category produces a
notebook alongside the master. Disabling it returns to the original
behaviour. Disabled partitions do not block the master publication.

### Phase 3 — Per-partition schedules and idle triggers (deferred)

* Add `finalization_time` and `min_idle_minutes` per partition in
  config.
* Replace the single "06:00 UTC, wait for queue empty" finalization
  with the per-partition rule from §5.1.
* Add `digestive notebook-status` to show each partition's readiness
  state in isolation.

**Acceptance:** with per-partition schedules, partitions finalize
independently. Master is always the upper-bound finalization time.

**Status:** deferred. Today's implementation keeps the single
fixed-time-of-day finalization for every partition in an edition. The
data behind §1.6 shows that no single finalization time strictly
minimises missed articles, but the operator's cron-schedulable
deterministic rule is more valuable than per-partition nuance until the
corpus grows materially. Tracked as future work.

### Phase 4 — Soft cap and overflow signalling (deferred)

* Apply the 50-source cap to **all** notebooks, including master.
* Write `notebook_excluded` signals for overflow documents.
* `digestive notebook-status` reports the exclusion count.

**Acceptance:** the master notebook is bounded at 50 sources; the
Markdown digest remains complete; excluded documents are visible in
`feedback-summary`.

**Status:** deferred. The corpus has hit 50+ documents on the master
edition at most once in the sample (58 articles on 2026-06-16, the
Reddit-burst day) and per-category partitions have *never* exceeded 50.
The 50-cap is therefore a future-proofing measure rather than a current
need, and the `notebook_excluded` signal substrate can be added without
a migration when it becomes load-bearing.

### Phase 5 — Out-of-scope future work (deferred)

* Per-cluster notebooks (rejected; revisit if corpus grows).
* Rolling 6-hour windows (rejected; revisit if corpus grows 5–10×).
* Miniflux webhook receiver (rejected; revisit if polling cost
  matters).
* "Same-day, no exceptions" late-arrival rule (rejected; revisit if a
  breaking-news source is added).

---

## 12. Open questions for the operator

1. **Default config:** enable YouTube partition from day one, or
   keep `master`-only and require explicit opt-in? My recommendation
   is the latter.
   **Resolved:** master-only is the default. With `PARTITION_CONFIG`
   unset (or empty), every document routes to `master`, the behaviour
   is identical to pre-feature PNIP, and no extra notebooks are
   produced. Operators opt in per category.
2. **`min_articles` defaults:** 5 for Blogs / 5 for Reddit / 8 for
   YouTube? (YouTube has higher typical volume, Reddit has higher
   zero-day rate.)
   **Resolved:** the resolver defaults each entry's `min_articles` to
   **5** when omitted in `PARTITION_CONFIG`. Operators tune per
   partition; the per-category numbers above are still appropriate
   starting points.
3. **`min_idle_minutes` defaults:** 30 minutes for everything, or
   per-partition (YouTube 20, Blogs 30, Reddit 60)?
   **Resolved (deferred):** finalization is the master edition's
   scheduled time-of-day for *every* partition in the edition (see
   Phase 3 deferred, §11). Per-partition `min_idle_minutes` is
   out of scope until Phase 3 ships.
4. **Finalization times:** all partitions at the master's time, or
   stagger (e.g., YouTube 04:00 UTC, Blogs 05:00 UTC, master 06:00
   UTC)? My recommendation is "all at master's time" for phase 2.
   **Resolved:** all partitions finalize at the master edition's
   scheduled time-of-day. The publication completion gate (§49) checks
   every active partition in lockstep before transitioning the
   edition to Published.
5. **Master notebook cap:** 50 (matches partitions) or higher
   (e.g., 100)? The corpus only hit 58 once in the sample.
   **Resolved (deferred):** the 50-cap is not yet enforced on the
   master notebook (Phase 4 deferred, §11). The current implementation
   uploads all master-partition documents; the cap will land with the
   `notebook_excluded` signal substrate when the corpus grows enough
   for the cap to matter.
6. **Bulk-import handling:** rely on operator to mark-read in
   Miniflux first, or add a "skip entries older than N days" guard
   in `discover`?
   **Resolved:** unchanged — operators mark-read in Miniflux first.
   Today's `discover` keeps fetching all unread entries; bulk-import
   protection is operator policy, not pipeline policy.

These are the only remaining decisions before phase 0/1 can ship. The
phase-2+ decisions can be made in their own tasks.

---

## 13. Acceptance criteria for this design

* [x] Recommendations are supported by evidence from the existing
      Miniflux data (§1).
* [x] The proposed workflow clearly explains how an article moves
      from Miniflux into a finalized notebook edition (§9).
* [x] Edge cases are identified and addressed (§6).
* [x] Trade-offs between different scheduling strategies are
      documented (§7, §8).
* [x] The design is detailed enough that implementation can begin in
      a separate task without significant architectural decisions
      remaining (§11, §12).
