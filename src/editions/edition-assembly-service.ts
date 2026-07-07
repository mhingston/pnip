import type { Kysely } from "kysely";
import type { Database, Edition } from "../database/kysely.js";
import {
  type StoryRepository,
  type StoryWithMembers,
} from "../clustering/story-repository.js";
import { type StorySummaryRepository } from "../clustering/story-summary-repository.js";
import {
  type EnrichmentTrackerRepository,
  REQUIRED_ENRICHMENT_TYPES,
} from "./enrichment-tracker-repository.js";
import { type EditionRepository } from "./edition-repository.js";

export interface AssembledStory extends StoryWithMembers {
  hasSummary: boolean;
  summaryId: string | null;
}

export interface EditionAssembly {
  edition: Edition;
  stories: AssembledStory[];
  totalDocuments: number;
  fullyEnrichedDocuments: number;
  expectedCompletedTypeRows: number;
  totalCompletedTypeRows: number;
  storiesWithSummaries: number;
  isReady: boolean;
  reason: string;
}

export interface EditionAssemblyService {
  collectStories(editionId: string): Promise<AssembledStory[]>;
  getReadiness(editionId: string): Promise<Omit<EditionAssembly, "edition" | "stories">>;
  isEditionReady(editionId: string): Promise<boolean>;
  assemble(editionId: string): Promise<EditionAssembly>;
}

export interface EditionAssemblyDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  storyRepo: StoryRepository;
  storySummaryRepo: StorySummaryRepository;
  enrichmentTracker: EnrichmentTrackerRepository;
}

function sortStoriesDeterministically(stories: AssembledStory[]): AssembledStory[] {
  return [...stories].sort((a, b) => {
    if (a.story.cluster_order !== b.story.cluster_order) {
      return a.story.cluster_order - b.story.cluster_order;
    }
    return a.story.label.localeCompare(b.story.label);
  });
}

export function createEditionAssemblyService(
  deps: EditionAssemblyDeps,
): EditionAssemblyService {
  return {
    async collectStories(editionId) {
      const stories = await deps.storyRepo.getByEdition(editionId);
      const out: AssembledStory[] = [];
      for (const s of stories) {
        const summary = await deps.storySummaryRepo.getByStoryId(s.story.id);
        out.push({
          ...s,
          hasSummary: summary !== undefined,
          summaryId: summary?.id ?? null,
        });
      }
      return sortStoriesDeterministically(out);
    },

    async getReadiness(editionId) {
      const counts = await deps.enrichmentTracker.getDocumentCounts(editionId);
      const stories = await deps.storyRepo.getByEdition(editionId);
      let storiesWithSummaries = 0;
      for (const s of stories) {
        const summary = await deps.storySummaryRepo.getByStoryId(s.story.id);
        if (summary !== undefined) storiesWithSummaries += 1;
      }
      const expectedCompletedTypeRows =
        counts.totalDocuments * REQUIRED_ENRICHMENT_TYPES.length;
      const everyDocumentFullyEnriched =
        counts.totalDocuments > 0 &&
        counts.fullyEnrichedDocuments === counts.totalDocuments;
      const everyStorySummarized =
        stories.length === 0 ? false : storiesWithSummaries === stories.length;
      const isReady = everyDocumentFullyEnriched && everyStorySummarized;
      let reason: string;
      if (isReady) {
        reason = "all documents fully enriched and all stories have summaries";
      } else if (counts.totalDocuments === 0) {
        reason = "no documents in edition";
      } else if (!everyDocumentFullyEnriched) {
        reason = `${counts.fullyEnrichedDocuments}/${counts.totalDocuments} documents fully enriched`;
      } else {
        reason = `${storiesWithSummaries}/${stories.length} stories have summaries`;
      }
      return {
        totalDocuments: counts.totalDocuments,
        fullyEnrichedDocuments: counts.fullyEnrichedDocuments,
        expectedCompletedTypeRows,
        totalCompletedTypeRows: counts.totalCompletedTypeRows,
        storiesWithSummaries,
        isReady,
        reason,
      };
    },

    async isEditionReady(editionId) {
      const r = await this.getReadiness(editionId);
      return r.isReady;
    },

    async assemble(editionId) {
      const edition = await deps.editionRepo.getById(editionId);
      if (!edition) {
        throw new Error(`edition not found: ${editionId}`);
      }
      const [stories, readiness] = await Promise.all([
        this.collectStories(editionId),
        this.getReadiness(editionId),
      ]);
      return { edition, stories, ...readiness };
    },
  };
}
