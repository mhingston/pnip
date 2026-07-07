# scripts/

Ad-hoc operator scripts for the `digestive` pipeline. These are not part of the
test suite and are intentionally not run in CI.

## `m6-e2e-driver.ts`

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

## `demo-gate-fire.ts`

Replays the enrichment-tracker + gate sequence against enrichments that were
actually produced by the real LLM (via `process`). Useful for validating the
`building → ready` claim atomicity outside the full CLI run.

Run only after `process` has produced at least one document's worth of
real-LLM enrichment rows; the script does not seed fake data. It re-marks the
tracker from scratch and demonstrates that calling the gate for the final
enrichment of the last document fires `cluster_stories` exactly once.
