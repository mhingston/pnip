import type { Logger } from "../../logging/logger.js";
import type { Edition } from "../../database/kysely.js";
import type { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type {
  EditionAssembly,
  EditionAssemblyService,
} from "../../editions/edition-assembly-service.js";
import type { StorySummaryRepository } from "../../clustering/story-summary-repository.js";
import type { DocumentRepository } from "../../expansion/document-repository.js";
import type { ChunkRepository } from "../../chunking/chunk-repository.js";
import type { TopicRepository } from "../../enrichment/topics/topic-repository.js";
import type {
  MarkdownDigestRepository,
  MarkdownDigestRow,
} from "./markdown-digest-repository.js";
import type { SignalRepository, CreateSignalInput } from "../../signals/signal-repository.js";
import { deriveSourceIdentity } from "../../signals/source-identity.js";
import { getBiasView, type BiasView } from "../../signals/bias-view.js";
import {
  buildCitationIndex,
  type CitationIndex,
} from "./citation-index.js";
import {
  classifyStoryContinuity,
  type ContinuityStoryIdentity,
  type StoryContinuity,
} from "./story-continuity.js";

export const DIGEST_TOP_STORIES_LIMIT = 50;

export const DIGEST_CATEGORY_ORDER = [
  "Technology",
  "Politics",
  "Science",
  "Business",
  "Interesting Reads",
  "Videos",
  "Reddit Discussions",
] as const;

export type DigestCategory = (typeof DIGEST_CATEGORY_ORDER)[number];

/**
 * Deterministic, in-source keyword heuristic used to bucket stories into the
 * §43 category sections. Pure and side-effect free — used by the renderer so
 * category routing is reproducible across reruns.
 */
export const CATEGORY_KEYWORDS: Record<
  Exclude<DigestCategory, "Videos" | "Reddit Discussions">,
  readonly string[]
> = {
  Technology: [
    "ai", "artificial intelligence", "llm", "large language model",
    "openai", "anthropic", "claude", "gpt", "gemini", "mistral", "llama",
    "machine learning", "deep learning", "neural", "transformer", "agent",
    "nvidia", "amd", "gpu", "chip", "hardware",
    "software", "github", "open source", "rust", "python", "javascript",
    "typescript", "developer", "programming", "kernel", "database", "api",
    "robot", "autonomous", "self-driving",
  ],
  Politics: [
    "election", "vote", "voting", "ballot", "poll",
    "senate", "congress", "parliament", "supreme court", "scotus",
    "president", "biden", "trump", "democrat", "republican",
    "government", "policy", "legislation", "law", "regulation",
    "minister", "state department", "white house",
  ],
  Science: [
    "research", "study", "paper", "preprint", "benchmark", "sota",
    "physics", "biology", "chemistry", "astronomy",
    "space", "nasa", "telescope", "james webb",
    "quantum", "gene", "crispr", "genome",
    "climate", "species", "evolution", "fossil", "experiment",
    "discovery", "scientist",
  ],
  Business: [
    "startup", "funding", "raises", "valuation", "raised",
    "acquisition", "acquires", "merger", "ipo",
    "stock", "market", "shares", "revenue", "earnings",
    "ceo", "company", "corporation", "enterprise",
    "layoff", "layoffs", "hiring", "investment",
    "profit", "loss", "quarterly", "antitrust",
  ],
  "Interesting Reads": [],
};

interface DocumentSnapshot {
  id: string;
  title: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  sourceType: string;
  publisher: string | null;
  chunkIds: string[];
  metadata?: unknown;
  /** Ranking assigned while the edition's story clusters were built. */
  editionRank?: number;
  similarity?: number;
}

export interface StorySnapshot {
  storyId: string;
  storyLabel: string;
  clusterOrder: number;
  documents: DocumentSnapshot[];
  summaryText: string;
  claims: { text: string; chunkId: string }[];
}

export interface MarkdownDigestResult {
  digestId: string;
  edition: Edition;
  storyCount: number;
  documentCount: number;
  citationCount: number;
  alreadyExisted: boolean;
}

export interface GenerateMarkdownDigestInput {
  editionId: string;
}

export interface MarkdownDigestService {
  generate(input: GenerateMarkdownDigestInput): Promise<MarkdownDigestResult>;
  generateForDate(input: {
    editionDate: string | Date;
  }): Promise<MarkdownDigestResult>;
  renderMarkdown(input: {
    edition: Edition;
    assembly: EditionAssembly;
    stories: StorySnapshot[];
    /** All ranked edition stories, including stories hidden from the body. */
    sourceStories?: StorySnapshot[];
    previousStories?: ContinuityStoryIdentity[];
    suppressedStoryCount?: number;
    citationIndex: CitationIndex;
  }): string;
  collectStories(editionId: string): Promise<StorySnapshot[]>;
  categorizeStory(story: StorySnapshot): DigestCategory;
}

export interface MarkdownDigestServiceDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  assembly: EditionAssemblyService;
  storySummaryRepo: StorySummaryRepository;
  docRepo: DocumentRepository;
  chunkRepo: ChunkRepository;
  topicRepo: TopicRepository;
  digestRepo: MarkdownDigestRepository;
  signalRepo: SignalRepository;
  biasEnabled?: boolean;
  presentation?: DigestPresentationConfig;
  loadPreviousStories?: (edition: Edition) => Promise<ContinuityStoryIdentity[]>;
  logger?: Logger;
}

export interface DigestPresentationConfig {
  /** Calibrates story prominence only; never removes stories or sources. */
  targetReadingMinutes?: number;
  /** Must come from an explicit upstream editorial assessment. */
  quietEditionReason?: "low_significance" | "low_novelty";
}

/**
 * Stub for the optional topic loader — kept off the public surface because the
 * keyword heuristic doesn't need them. Reserved for a future LLM-assisted
 * categorizer (see §65 Phase C/D). Returns an empty Map so callers don't need
 * to special-case the loader.
 */
export interface TopicsByDocumentLoader {
  loadTopicsByDocumentId(
    editionId: string,
  ): Promise<Map<string, string[]>>;
}

export function createTopicsByDocumentLoader(deps: {
  docRepo: DocumentRepository;
  topicRepo: TopicRepository;
}): TopicsByDocumentLoader {
  return {
    async loadTopicsByDocumentId(editionId) {
      const documents = await deps.docRepo.getByEdition(editionId);
      const out = new Map<string, string[]>();
      for (const d of documents) {
        const topics = await deps.topicRepo.getByDocumentId(d.id);
        out.set(
          d.id,
          Array.from(new Set(topics.map((t) => t.topic.toLowerCase()))),
        );
      }
      return out;
    },
  };
}

async function writeClaimedInTopSignals(
  deps: Pick<MarkdownDigestServiceDeps, "signalRepo" | "logger">,
  editionId: string,
  stories: StorySnapshot[],
  previousStories: ContinuityStoryIdentity[],
  presentation?: DigestPresentationConfig,
): Promise<void> {
  const topStoriesLimit = presentation?.targetReadingMinutes === undefined
    ? DIGEST_TOP_STORIES_LIMIT
    : Math.max(1, Math.round(presentation.targetReadingMinutes / 2));
  const topStories = stories
    .filter((story) => classifyStoryContinuity(
      {
        label: story.storyLabel,
        urls: story.documents.map((doc) => doc.canonicalUrl ?? doc.sourceUrl),
      },
      previousStories,
    ).kind === "new")
    .slice(0, topStoriesLimit);
  if (topStories.length === 0) return;
  const signalInputs: CreateSignalInput[] = topStories.map((s, index) => ({
    signal_kind: "claimed_in_top",
    edition_id: editionId,
    story_id: s.storyId,
    source_url: null,
    source_identity: null,
    payload: { top_position: index + 1, label: s.storyLabel },
  }));
  try {
    await deps.signalRepo.createBatch(signalInputs);
  } catch (err) {
    deps.logger?.warn("failed to insert claimed_in_top signals", {
      editionId,
      error: err as Error,
    });
  }
}

function storyDocumentIdentities(story: StorySnapshot): (string | null)[] {
  return story.documents.map((d) =>
    deriveSourceIdentity({
      sourceUrl: d.sourceUrl,
      sourceType: d.sourceType,
      publisher: d.publisher,
      metadata: d.metadata ?? null,
    }),
  );
}

function applyBiasToStories(
  stories: StorySnapshot[],
  bias: BiasView,
): StorySnapshot[] {
  if (bias.mutedSourceIdentities.size === 0 && bias.storyBias.size === 0) {
    return stories;
  }
  const kept: StorySnapshot[] = [];
  for (const story of stories) {
    if (story.documents.length > 0) {
      const identities = storyDocumentIdentities(story);
      const mutedCount = identities.filter(
        (id) => id !== null && bias.mutedSourceIdentities.has(id),
      ).length;
      if (mutedCount === story.documents.length) continue;
    }
    kept.push(story);
  }
  const downRatedIds = new Set<string>();
  for (const story of kept) {
    const entry = bias.storyBias.get(story.storyId);
    if (entry && entry.net_score < 0) downRatedIds.add(story.storyId);
  }
  if (downRatedIds.size === 0) return kept;
  const nonDownRated = kept.filter((s) => !downRatedIds.has(s.storyId));
  const downRated = kept.filter((s) => downRatedIds.has(s.storyId));
  return [...nonDownRated, ...downRated];
}

function formatPublicationDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const d = value;
  if (Number.isNaN(d.valueOf())) return String(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function bullet(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return `- ${trimmed}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function pickSourceTypes(documents: DocumentSnapshot[]): Set<string> {
  return new Set(documents.map((d) => d.sourceType.toLowerCase()));
}

function matchesCategory(
  haystack: string,
  category: Exclude<DigestCategory, "Videos" | "Reddit Discussions">,
): boolean {
  for (const kw of CATEGORY_KEYWORDS[category]) {
    if (kw.includes(" ")) {
      if (haystack.includes(kw)) return true;
    } else {
      const tokens = haystack.split(/[^a-z0-9]+/);
      if (tokens.includes(kw)) return true;
    }
  }
  return false;
}

function storyHaystack(story: StorySnapshot): string {
  return [
    story.storyLabel,
    ...story.documents.flatMap((d) => [
      d.title,
      d.publisher ?? "",
    ]),
  ]
    .join(" \n ")
    .toLowerCase();
}

async function loadPreviousEditionStories(
  db: Kysely<Database>,
  edition: Edition,
): Promise<ContinuityStoryIdentity[]> {
  if (typeof (db as unknown as { selectFrom?: unknown }).selectFrom !== "function") {
    return [];
  }
  const previousEdition = await db
    .selectFrom("editions")
    .select("id")
    .where("publication_date", "<", edition.publication_date)
    .where("partition_key", "=", "master")
    .orderBy("publication_date", "desc")
    .executeTakeFirst();
  if (!previousEdition) return [];

  const rows = await db
    .selectFrom("story_clusters as sc")
    .innerJoin("cluster_members as cm", "cm.story_id", "sc.id")
    .innerJoin("documents as d", "d.id", "cm.document_id")
    .select([
      "sc.id as story_id",
      "sc.label as story_label",
      "d.source_url as source_url",
      "d.canonical_url as canonical_url",
    ])
    .where("sc.edition_id", "=", previousEdition.id)
    .orderBy("sc.cluster_order", "asc")
    .execute();

  const byStory = new Map<string, ContinuityStoryIdentity>();
  for (const row of rows) {
    const identity = byStory.get(row.story_id) ?? {
      label: row.story_label,
      urls: [],
    };
    identity.urls.push(row.canonical_url ?? row.source_url);
    byStory.set(row.story_id, identity);
  }
  return [...byStory.values()];
}

export function createMarkdownDigestService(
  deps: MarkdownDigestServiceDeps,
): MarkdownDigestService {
  return {
    async generate(input) {
      const edition = await deps.editionRepo.getById(input.editionId);
      if (!edition) {
        throw new Error(`edition not found: ${input.editionId}`);
      }

      const existing = await deps.digestRepo.getByEdition(input.editionId);
      if (existing) {
        deps.logger?.info("markdown digest already exists for edition; skipping", {
          editionId: input.editionId,
          digestId: existing.id,
        });
        try {
          const existingStories = await this.collectStories(input.editionId);
          const previousStories = deps.loadPreviousStories
            ? await deps.loadPreviousStories(edition)
            : await loadPreviousEditionStories(deps.db, edition);
          await writeClaimedInTopSignals(
            deps,
            input.editionId,
            existingStories,
            previousStories,
            deps.presentation,
          );
        } catch (err) {
          deps.logger?.warn("failed to write claimed_in_top signals for existing digest", {
            editionId: input.editionId,
            error: err as Error,
          });
        }
        return {
          digestId: existing.id,
          edition,
          storyCount: existing.story_count,
          documentCount: existing.document_count,
          citationCount: existing.citation_count,
          alreadyExisted: true,
        };
      }

      const assembly = await deps.assembly.assemble(input.editionId);
      const stories = await this.collectStories(input.editionId);

      if (stories.length === 0) {
        throw new Error(
          `edition ${input.editionId} has no stories with summaries; ` +
            `cannot generate Markdown digest`,
        );
      }

      let effectiveStories = stories;
      if (deps.biasEnabled) {
        const biasView = await getBiasView(deps.db, input.editionId);
        effectiveStories = applyBiasToStories(stories, biasView);
      }

      const allCitations = effectiveStories.flatMap((s) =>
        s.claims.map((c) => {
          const doc = s.documents.find((d) =>
            d.chunkIds.includes(c.chunkId),
          );
          return {
            chunkId: c.chunkId,
            claimText: c.text,
            documentId: doc?.id,
          };
        }),
      );
      const citationIndex = buildCitationIndex(allCitations);

      const previousStories = deps.loadPreviousStories
        ? await deps.loadPreviousStories(edition)
        : await loadPreviousEditionStories(deps.db, edition);
      const markdown = this.renderMarkdown({
        edition,
        assembly,
        stories: effectiveStories,
        sourceStories: stories,
        previousStories,
        suppressedStoryCount:
          deps.biasEnabled && stories.length > effectiveStories.length
            ? stories.length - effectiveStories.length
            : undefined,
        citationIndex,
      });

      const documentIds = new Set<string>();
      for (const s of effectiveStories) {
        for (const d of s.documents) documentIds.add(d.id);
      }

      let row: MarkdownDigestRow;
      try {
        row = await deps.digestRepo.createForEdition({
          editionId: input.editionId,
          content: markdown,
          storyCount: effectiveStories.length,
          documentCount: documentIds.size,
          citationCount: citationIndex.entries.length,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          err.name === "MarkdownDigestConflictError"
        ) {
          const after = await deps.digestRepo.getByEdition(input.editionId);
          if (after) {
            deps.logger?.info(
              "markdown digest race resolved; returning existing row",
              { editionId: input.editionId, digestId: after.id },
            );
            await writeClaimedInTopSignals(
              deps,
              input.editionId,
              effectiveStories,
              previousStories,
              deps.presentation,
            );
            return {
              digestId: after.id,
              edition,
              storyCount: after.story_count,
              documentCount: after.document_count,
              citationCount: after.citation_count,
              alreadyExisted: true,
            };
          }
        }
        throw err;
      }

      deps.logger?.info("markdown digest created", {
        editionId: edition.id,
        digestId: row.id,
        storyCount: effectiveStories.length,
        documentCount: documentIds.size,
        citationCount: citationIndex.entries.length,
      });

      await writeClaimedInTopSignals(
        deps,
        input.editionId,
        effectiveStories,
        previousStories,
        deps.presentation,
      );

      return {
        digestId: row.id,
        edition,
        storyCount: effectiveStories.length,
        documentCount: documentIds.size,
        citationCount: citationIndex.entries.length,
        alreadyExisted: false,
      };
    },

    async generateForDate(input) {
      const edition = await deps.editionRepo.getByDate(input.editionDate);
      if (!edition) {
        throw new Error(`no edition found for date ${String(input.editionDate)}`);
      }
      return this.generate({ editionId: edition.id });
    },

    async collectStories(editionId) {
      const stories = await deps.assembly.collectStories(editionId);
      const out: StorySnapshot[] = [];
      for (const s of stories) {
        const documents: DocumentSnapshot[] = [];
        for (const m of s.members) {
          const doc = await deps.docRepo.getById(m.document_id);
          if (!doc) continue;
          const chunkIds = await deps.chunkRepo
            .getByDocumentId(doc.id)
            .then((cs) => cs.map((c) => c.id));
          documents.push({
            id: doc.id,
            title: doc.title ?? "Untitled",
            sourceUrl: doc.source_url,
            canonicalUrl: doc.canonical_url ?? null,
            sourceType: doc.source_type,
            publisher: doc.publisher ?? null,
            chunkIds,
            metadata: doc.metadata,
            similarity: m.similarity,
          });
        }
        documents.sort((a, b) =>
          (b.similarity ?? 0) - (a.similarity ?? 0) ||
          a.sourceUrl.localeCompare(b.sourceUrl),
        );

        const summaryRow = s.hasSummary
          ? await deps.storySummaryRepo.getByStoryId(s.story.id)
          : undefined;
        if (!summaryRow) continue;
        const citations =
          (await deps.storySummaryRepo.getCitationsBySummaryId(summaryRow.id)) ?? [];

        out.push({
          storyId: s.story.id,
          storyLabel: s.story.label,
          clusterOrder: s.story.cluster_order,
          documents: documents.map((document, memberIndex) => ({
            ...document,
            editionRank: s.story.cluster_order * 1_000_000 + memberIndex,
          })),
          summaryText: summaryRow.content,
          claims: citations
            .filter((c) => typeof c.chunk_id === "string" && c.chunk_id.length > 0)
            .map((c) => ({ text: c.claim_text, chunkId: c.chunk_id })),
        });
      }
      return out;
    },

    categorizeStory(story) {
      const sourceTypes = pickSourceTypes(story.documents);
      if (sourceTypes.has("reddit")) return "Reddit Discussions";
      if (sourceTypes.has("youtube") || sourceTypes.has("podcast")) {
        return "Videos";
      }

      const haystack = storyHaystack(story);
      const order: Exclude<DigestCategory, "Videos" | "Reddit Discussions">[] = [
        "Technology",
        "Politics",
        "Science",
        "Business",
      ];
      for (const cat of order) {
        if (matchesCategory(haystack, cat)) return cat;
      }
      return "Interesting Reads";
    },

    renderMarkdown({
      edition,
      assembly,
      stories,
      sourceStories = stories,
      previousStories = [],
      suppressedStoryCount,
      citationIndex,
    }) {
      const publicationDate = formatPublicationDate(edition.publication_date);

      const renderedStories = stories;
      const withContinuity = renderedStories.map((story) => ({
        story,
        continuity: classifyStoryContinuity(
          {
            label: story.storyLabel,
            urls: story.documents.map((doc) => doc.canonicalUrl ?? doc.sourceUrl),
          },
          previousStories,
        ),
      }));
      const newStories = withContinuity.filter((item) => item.continuity.kind === "new");
      const continuingStories = withContinuity.filter((item) => item.continuity.kind === "continuing");
      const topStoriesLimit = deps.presentation?.targetReadingMinutes === undefined
        ? DIGEST_TOP_STORIES_LIMIT
        : Math.max(1, Math.round(deps.presentation.targetReadingMinutes / 2));
      const topStories = newStories.slice(0, topStoriesLimit);
      const remainingStories = newStories.slice(topStoriesLimit);

      const allDocs = new Map<string, DocumentSnapshot>();
      for (const s of sourceStories) {
        for (const d of s.documents) {
          if (!allDocs.has(d.id)) allDocs.set(d.id, d);
        }
      }
      const sortedDocs = [...allDocs.values()].sort((a, b) =>
        (a.editionRank ?? Number.MAX_SAFE_INTEGER) -
          (b.editionRank ?? Number.MAX_SAFE_INTEGER) ||
        a.sourceUrl.localeCompare(b.sourceUrl),
      );

      const lines: string[] = [];
      if (deps.presentation?.quietEditionReason) {
        const reason = deps.presentation.quietEditionReason === "low_novelty"
          ? "Today’s reporting has limited novelty, so this edition emphasizes context over urgency."
          : "Today’s reporting contains fewer high-significance developments, so this edition emphasizes useful context.";
        lines.push(`_Quiet edition: ${reason}_`);
        lines.push("");
      }
      const repeatedReceipt = continuingStories.length > 0
        ? `; repeated ${continuingStories.length} ${continuingStories.length === 1 ? "story" : "stories"}`
        : "";
      const suppressedReceipt = suppressedStoryCount !== undefined && suppressedStoryCount > 0
        ? `; suppressed ${suppressedStoryCount} ${suppressedStoryCount === 1 ? "story" : "stories"}`
        : "";
      lines.push(
        `_Coverage: reviewed ${assembly.totalDocuments} sources; included ${sortedDocs.length} sources across ${renderedStories.length} stories${repeatedReceipt}${suppressedReceipt}._`,
      );
      lines.push("");
      lines.push("## Top Stories");
      lines.push("");
      if (topStories.length === 0) {
        lines.push(
          continuingStories.length > 0
            ? "_No new lead stories; continuing coverage follows._"
            : "_No top stories selected for this edition._",
        );
      } else {
        for (const { story } of topStories) {
          for (const line of renderStorySection(story, citationIndex)) {
            lines.push(line);
          }
        }
      }
      lines.push("");

      if (remainingStories.length > 0) {
        lines.push("## More Stories");
        lines.push("");
        for (const { story } of remainingStories) {
          for (const line of renderStorySection(story, citationIndex)) {
            lines.push(line);
          }
        }
        lines.push("");
      }

      if (continuingStories.length > 0) {
        lines.push("## Continuing coverage");
        lines.push("");
        lines.push("_Stories also covered in the previous edition._");
        lines.push("");
        for (const { story, continuity } of continuingStories) {
          for (const line of renderStorySection(story, citationIndex, continuity)) {
            lines.push(line);
          }
        }
        lines.push("");
      }

      lines.push("## Sources");
      lines.push("");
      if (sortedDocs.length === 0) {
        lines.push("_No sources._");
      } else {
        for (const d of sortedDocs) {
          const url = d.canonicalUrl ?? d.sourceUrl;
          const sourceName = d.publisher?.trim() || d.title;
          lines.push(
            `- [${escapeMarkdown(sourceName)}](${url})`,
          );
        }
      }
      lines.push("");

      return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    },
  };
}

function renderStorySection(
  story: StorySnapshot,
  _index: CitationIndex,
  continuity?: StoryContinuity,
): string[] {
  const out: string[] = [];
  const leadSource = story.documents[0];
  const title = escapeMarkdown(story.storyLabel);
  out.push(
    leadSource
      ? `### [${title}](${leadSource.canonicalUrl ?? leadSource.sourceUrl})`
      : `### ${title}`,
  );
  out.push("");
  if (continuity?.kind === "continuing") {
    const reason = continuity.reason === "shared_source" ? "same source" : "same specific story label";
    out.push(
      `_Continues yesterday's coverage: ${escapeMarkdown(continuity.previousStoryLabel)} (${reason})._`,
    );
    out.push("");
  }
  out.push(escapeMarkdown(story.summaryText));
  out.push("");
  if (story.claims.length > 0) {
    out.push("_Key details:_");
    for (const claim of story.claims) {
      out.push(bullet(escapeMarkdown(claim.text)));
    }
    out.push("");
  }
  return out;
}
