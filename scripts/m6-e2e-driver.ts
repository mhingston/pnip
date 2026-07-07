import { Kysely, PostgresDialect, CompiledQuery, sql } from "kysely";
import { createPool } from "../src/database/pool.js";
import { type Database } from "../src/database/kysely.js";
import { createEnrichmentTrackerRepository, REQUIRED_ENRICHMENT_TYPES } from "../src/editions/enrichment-tracker-repository.js";
import { createEnrichmentGateService } from "../src/editions/enrichment-gate-service.js";
import { createEditionRepository } from "../src/editions/edition-repository.js";
import { createStoryRepository } from "../src/clustering/story-repository.js";
import { createStorySummaryRepository } from "../src/clustering/story-summary-repository.js";
import { createEditionAssemblyService } from "../src/editions/edition-assembly-service.js";
import { createEditionReadinessGate } from "../src/editions/edition-readiness-gate.js";
import { createPromptRepository } from "../src/prompts/prompt-repository.js";

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL!);
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
      onReserveConnection: async (c) => {
        await c.executeQuery(CompiledQuery.raw("SET search_path TO public"));
      },
    }),
  });
  try {
    const editionId = "b6bcf915-c7d5-46e7-858e-0073da7241f8";
    const ed = await db
      .selectFrom("editions")
      .selectAll()
      .where("id", "=", editionId)
      .executeTakeFirstOrThrow();
    console.log(`[E2E] edition ${ed.id} status=${ed.status}`);

    const docs = await db
      .selectFrom("documents")
      .selectAll()
      .where("edition_id", "=", editionId)
      .execute();
    console.log(`[E2E] ${docs.length} documents in edition`);

    const enrichmentTracker = createEnrichmentTrackerRepository(db);
    const enrichmentGate = createEnrichmentGateService({ db, tracker: enrichmentTracker });
    const editionRepo = createEditionRepository(db);
    const storyRepo = createStoryRepository(db);
    const storySummaryRepo = createStorySummaryRepository(db);
    const promptRepo = createPromptRepository(db);
    const assembly = createEditionAssemblyService({
      db,
      editionRepo,
      storyRepo,
      storySummaryRepo,
      enrichmentTracker,
    });
    const readinessGate = createEditionReadinessGate({
      db,
      editionRepo,
      assembly,
    });

    console.log("\n[E2E] step 1: seed fake enrichment rows so the tracker has all 5 done for each doc");
    for (const doc of docs) {
      const chunk = await db
        .selectFrom("document_chunks")
        .selectAll()
        .where("document_id", "=", doc.id)
        .limit(1)
        .executeTakeFirstOrThrow();
      for (const t of REQUIRED_ENRICHMENT_TYPES) {
        const table =
          t === "summarize_chunk"
            ? "summaries"
            : t === "extract_entities"
              ? "entities"
              : t === "assign_topics"
                ? "topics"
                : t === "embed_chunk"
                  ? "embeddings"
                  : "quality_classifications";
        const exists = await db
          .selectFrom(table as any)
          .select("id")
          .where("chunk_id", "=", chunk.id)
          .executeTakeFirst();
        if (!exists) {
          if (t === "summarize_chunk") {
            await db
              .insertInto("summaries")
              .values({
                chunk_id: chunk.id,
                document_id: doc.id,
                content: `summary of ${doc.title ?? doc.id}`,
                prompt_id: (await promptRepo.getLatestVersion("summary"))!.id,
                prompt_version: 1,
                model: "fake",
                provider: "fake",
                input_hash: `h-${doc.id}`,
              })
              .execute();
          } else if (t === "extract_entities") {
            await db
              .insertInto("entities")
              .values({
                chunk_id: chunk.id,
                document_id: doc.id,
                name: `Entity-${doc.id.slice(0, 4)}`,
                entity_type: "ORG",
                prompt_id: (await promptRepo.getLatestVersion("entities"))!.id,
                prompt_version: 1,
                model: "fake",
                provider: "fake",
                input_hash: `h-${doc.id}`,
              })
              .execute();
          } else if (t === "assign_topics") {
            await db
              .insertInto("topics")
              .values({
                chunk_id: chunk.id,
                document_id: doc.id,
                topic: "tech",
                confidence: 0.9,
                prompt_id: (await promptRepo.getLatestVersion("topics"))!.id,
                prompt_version: 1,
                model: "fake",
                provider: "fake",
                input_hash: `h-${doc.id}`,
              })
              .execute();
          } else if (t === "embed_chunk") {
            const vec = new Array(384).fill(0).map((_, i) => (i + 1) / 1000);
            const vecStr = `[${vec.join(",")}]`;
            await db
              .insertInto("embeddings")
              .values({
                chunk_id: chunk.id,
                vector: sql`${vecStr}::vector`,
                model: "fake",
                provider: "fake",
                input_hash: `h-${doc.id}`,
              })
              .execute();
          } else if (t === "classify_quality") {
            await db
              .insertInto("quality_classifications")
              .values({
                chunk_id: chunk.id,
                document_id: doc.id,
                label: "high",
                confidence: 0.95,
                reasoning: "looks good",
                prompt_id: (await promptRepo.getLatestVersion("quality"))!.id,
                prompt_version: 1,
                model: "fake",
                provider: "fake",
                input_hash: `h-${doc.id}`,
              })
              .execute();
          }
        }
      }
    }
    console.log(`[E2E] seeded enrichment rows for ${docs.length} docs`);

    console.log("\n[E2E] step 2: reset edition cluster_stories claim and tracker (re-chunk semantics)");
    await db
      .updateTable("editions")
      .set({ cluster_stories_enqueued_at: null, updated_at: new Date() })
      .where("id", "=", editionId)
      .execute();
    await db.deleteFrom("document_enrichment_status").execute();

    console.log("\n[E2E] step 3: call the gate from doc 1, last enrichment type (should be NULL — not the last)");
    const res1 = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(
      editionId,
      docs[0]!.id,
      "summarize_chunk",
    );
    console.log(`[E2E] gate after summarize_chunk for doc 1: ${res1 === null ? "null (doc not done)" : "enqueued cluster_stories"}`);

    console.log("\n[E2E] step 4: mark all 5 done for doc 1, then mark all 5 done for doc 2 → gate fires once at the end");
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await enrichmentTracker.markDone(docs[0]!.id, t);
    }
    const a = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(editionId, docs[0]!.id, "summarize_chunk");
    console.log(`[E2E] gate after last enrichment for doc 1: ${a ? "enqueued cluster_stories" : "null"}`);
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await enrichmentTracker.markDone(docs[1]!.id, t);
    }
    const b = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(editionId, docs[1]!.id, "summarize_chunk");
    console.log(`[E2E] gate after last enrichment for doc 2: ${b ? "enqueued cluster_stories" : "null"}`);
    for (const t of REQUIRED_ENRICHMENT_TYPES) {
      await enrichmentTracker.markDone(docs[2]!.id, t);
    }
    const c = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(editionId, docs[2]!.id, "summarize_chunk");
    console.log(`[E2E] gate after last enrichment for doc 3: ${c ? "enqueued cluster_stories" : "null (already enqueued)"}`);

    const claimedAt = await enrichmentTracker.getEditionEnqueuedAt(editionId);
    console.log(`[E2E] edition.cluster_stories_enqueued_at = ${claimedAt?.toISOString()}`);

    console.log("\n[E2E] step 5: create a story (manually, since cluster_stories needs embedding similarity)");
    const promptForStory = await promptRepo.getLatestVersion("story_summary");
    if (!promptForStory) {
      await promptRepo.createNewVersion({
        name: "story_summary",
        template: "summary: {{story_label}}",
        purpose: "story master summary",
      });
    }
    const replaced = await storyRepo.replaceForEdition({
      editionId,
      stories: [{ label: "E2E test story", documentIds: [docs[0]!.id, docs[1]!.id, docs[2]!.id] }],
    });
    const storyId = replaced.stories[0]!.story.id;
    console.log(`[E2E] created story ${storyId} with ${replaced.stories[0]!.members.length} members`);

    const promptFinal = (await promptRepo.getLatestVersion("story_summary"))!;
    const chunk0 = await db
      .selectFrom("document_chunks")
      .selectAll()
      .where("document_id", "=", docs[0]!.id)
      .limit(1)
      .executeTakeFirstOrThrow();
    await storySummaryRepo.replaceForStory({
      storyId,
      content: "E2E test master summary",
      promptId: promptFinal.id,
      promptVersion: promptFinal.version,
      model: "fake",
      provider: "fake",
      inputHash: "h",
      claims: [{ text: "E2E test claim", chunkId: chunk0.id }],
    });
    console.log(`[E2E] created story summary`);

    console.log("\n[E2E] step 6: read readiness");
    const r1 = await assembly.getReadiness(editionId);
    console.log(`[E2E] readiness: isReady=${r1.isReady} reason=${r1.reason}`);
    console.log(`  total=${r1.totalDocuments} fullyEnriched=${r1.fullyEnrichedDocuments} stories=${r1.storiesWithSummaries}/${docs.length > 0 ? "1" : "0"}`);

    console.log("\n[E2E] step 7: transition building -> ready via readiness gate");
    const edBefore = await editionRepo.getById(editionId);
    console.log(`[E2E] edition status before: ${edBefore!.status}`);
    const tr = await readinessGate.transitionToReadyIfReady(editionId);
    console.log(`[E2E] transition: transitioned=${tr.transitioned} reason=${tr.reason} newStatus=${tr.edition.status}`);

    const edAfter = await editionRepo.getById(editionId);
    console.log(`[E2E] edition status after: ${edAfter!.status}`);

    console.log("\n[E2E] step 8: try transition again — should be no-op (already ready)");
    const tr2 = await readinessGate.transitionToReadyIfReady(editionId);
    console.log(`[E2E] second transition: transitioned=${tr2.transitioned} reason=${tr2.reason}`);

    console.log("\n[E2E] step 9: state guard check — is processing still allowed?");
    const allowed = await editionRepo.isProcessingAllowed(editionId);
    console.log(`[E2E] isProcessingAllowed(ready) = ${allowed}`);

    console.log("\n[E2E] step 10: try to mark an enrichment done on a ready edition — gate returns null (no re-enqueue)");
    const d3 = await enrichmentGate.markEnrichmentDoneAndMaybeEnqueueCluster(editionId, docs[0]!.id, "summarize_chunk");
    console.log(`[E2E] gate call on ready edition: ${d3 === null ? "null (correct)" : "ENQUEUED (BUG!)"}`);

    console.log("\n[E2E] step 11: assemble() returns the full snapshot");
    const snap = await assembly.assemble(editionId);
    console.log(`[E2E] snapshot: edition.status=${snap.edition.status} stories=${snap.stories.length} ready=${snap.isReady} reason="${snap.reason}"`);
    for (const s of snap.stories) {
      console.log(`  - story "${s.story.label}" order=${s.story.cluster_order} members=${s.members.length} hasSummary=${s.hasSummary}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  process.exit(1);
});
