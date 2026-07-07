import { Kysely, type Transaction } from "kysely";
import type { Database } from "../database/kysely.js";

export interface StoryClusterRow {
  id: string;
  edition_id: string;
  label: string;
  cluster_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface ClusterMemberRow {
  id: string;
  story_id: string;
  document_id: string;
  role: string;
  similarity: number;
  created_at: Date;
}

export interface StoryWithMembers {
  story: StoryClusterRow;
  members: ClusterMemberRow[];
}

export interface ReplaceEditionStoriesInput {
  editionId: string;
  stories: {
    label: string;
    documentIds: string[];
  }[];
  similarities?: Map<string, number>;
}

export interface ReplaceEditionStoriesResult {
  stories: StoryWithMembers[];
  removedStoryIds: string[];
}

export interface StoryRepository {
  replaceForEdition(
    input: ReplaceEditionStoriesInput,
    tx?: Kysely<Database> | Transaction<Database>,
  ): Promise<ReplaceEditionStoriesResult>;
  getById(id: string): Promise<StoryClusterRow | undefined>;
  getByEdition(editionId: string): Promise<StoryWithMembers[]>;
  getMembers(storyId: string): Promise<ClusterMemberRow[]>;
  getStoryForDocument(documentId: string): Promise<StoryClusterRow | undefined>;
  deleteByEdition(editionId: string): Promise<void>;
}

export function createStoryRepository(db: Kysely<Database>): StoryRepository {
  return {
    async replaceForEdition(input, tx) {
      const conn = tx ?? db;
      return conn.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("story_clusters")
          .select("id")
          .where("edition_id", "=", input.editionId)
          .execute();
        const existingIds = new Set(existing.map((e) => e.id));

        if (existingIds.size > 0) {
          await trx
            .deleteFrom("cluster_members")
            .where("story_id", "in", [...existingIds])
            .execute();
        }
        await trx
          .deleteFrom("story_clusters")
          .where("edition_id", "=", input.editionId)
          .execute();

        const result: StoryWithMembers[] = [];

        for (let i = 0; i < input.stories.length; i++) {
          const storyInput = input.stories[i];
          if (storyInput.documentIds.length === 0) continue;
          const story = await trx
            .insertInto("story_clusters")
            .values({
              edition_id: input.editionId,
              label: storyInput.label,
              cluster_order: i,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const members: ClusterMemberRow[] = [];
          for (const documentId of storyInput.documentIds) {
            const similarity =
              input.similarities?.get(`${story.id}:${documentId}`) ??
              input.similarities?.get(documentId) ??
              0;
            const member = await trx
              .insertInto("cluster_members")
              .values({
                story_id: story.id,
                document_id: documentId,
                role: "supporting",
                similarity,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            members.push(member);
          }
          result.push({ story, members });
        }

        return {
          stories: result,
          removedStoryIds: [...existingIds],
        };
      });
    },

    async getById(id) {
      return db
        .selectFrom("story_clusters")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async getByEdition(editionId) {
      const stories = await db
        .selectFrom("story_clusters")
        .selectAll()
        .where("edition_id", "=", editionId)
        .orderBy("cluster_order", "asc")
        .execute();
      if (stories.length === 0) return [];
      const storyIds = stories.map((s) => s.id);
      const members = await db
        .selectFrom("cluster_members")
        .selectAll()
        .where("story_id", "in", storyIds)
        .orderBy("created_at", "asc")
        .execute();
      const byStory = new Map<string, ClusterMemberRow[]>();
      for (const m of members) {
        const arr = byStory.get(m.story_id) ?? [];
        arr.push(m);
        byStory.set(m.story_id, arr);
      }
      return stories.map((s) => ({
        story: s,
        members: byStory.get(s.id) ?? [],
      }));
    },

    async getMembers(storyId) {
      return db
        .selectFrom("cluster_members")
        .selectAll()
        .where("story_id", "=", storyId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async getStoryForDocument(documentId) {
      const row = await db
        .selectFrom("cluster_members")
        .select("story_id")
        .where("document_id", "=", documentId)
        .executeTakeFirst();
      if (!row) return undefined;
      return db
        .selectFrom("story_clusters")
        .selectAll()
        .where("id", "=", row.story_id)
        .executeTakeFirst();
    },

    async deleteByEdition(editionId) {
      await db
        .deleteFrom("story_clusters")
        .where("edition_id", "=", editionId)
        .execute();
    },
  };
}
