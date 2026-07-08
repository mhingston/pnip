import { Kysely, sql } from "kysely";
import type { Database } from "../database/kysely.js";

export interface SignalRow {
  id: string;
  signal_kind: string;
  edition_id: string;
  story_id: string | null;
  chunk_id: string | null;
  document_id: string | null;
  source_url: string | null;
  source_identity: string | null;
  payload: unknown;
  created_at: Date;
}

export interface CreateSignalInput {
  signal_kind: string;
  edition_id: string;
  story_id?: string | null;
  chunk_id?: string | null;
  document_id?: string | null;
  source_url?: string | null;
  source_identity?: string | null;
  payload?: unknown;
}

export interface MutedSourceAggregate {
  source_identity: string;
  mute_count: number;
}

export interface VotedStoryAggregate {
  story_id: string;
  net_score: number;
  up: number;
  down: number;
}

export interface StarredChunkAggregate {
  chunk_id: string;
  star_count: number;
}

export interface FeedbackSummary {
  signalCounts: Record<string, number>;
  totalSignals: number;
  topMutedSources: MutedSourceAggregate[];
  topVotedStories: VotedStoryAggregate[];
  topStarredChunks: StarredChunkAggregate[];
  sourceIdentityCount: number;
  storyVoteCount: number;
}

export interface SourceIdentityStats {
  source_identity: string;
  mute_count: number;
  chunk_star_count: number;
  cited_in_story_count: number;
  total_signals: number;
}

export interface SignalRepository {
  createBatch(inputs: CreateSignalInput[]): Promise<SignalRow[]>;
  getByEdition(editionId: string): Promise<SignalRow[]>;
  getByEditionAndKind(
    editionId: string,
    signalKind: string,
  ): Promise<SignalRow[]>;
  countByEditionAndKind(
    editionId: string,
    signalKind: string,
  ): Promise<number>;
  getBySourceIdentity(sourceIdentity: string): Promise<SignalRow[]>;
  getFeedbackSummary(
    opts?: { editionId?: string; limit?: number },
  ): Promise<FeedbackSummary>;
  getSourceIdentityStats(sourceIdentity: string): Promise<SourceIdentityStats>;
}

export function createSignalRepository(db: Kysely<Database>): SignalRepository {
  return {
    async createBatch(inputs) {
      if (inputs.length === 0) return [];
      return db
        .insertInto("signals")
        .values(
          inputs.map((input) => ({
            signal_kind: input.signal_kind,
            edition_id: input.edition_id,
            story_id: input.story_id ?? null,
            chunk_id: input.chunk_id ?? null,
            document_id: input.document_id ?? null,
            source_url: input.source_url ?? null,
            source_identity: input.source_identity ?? null,
            payload: JSON.stringify(input.payload ?? {}),
          })),
        )
        .returningAll()
        .execute();
    },

    async getByEdition(editionId) {
      return db
        .selectFrom("signals")
        .selectAll()
        .where("edition_id", "=", editionId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async getByEditionAndKind(editionId, signalKind) {
      return db
        .selectFrom("signals")
        .selectAll()
        .where("edition_id", "=", editionId)
        .where("signal_kind", "=", signalKind)
        .orderBy("created_at", "asc")
        .execute();
    },

    async countByEditionAndKind(editionId, signalKind) {
      const result = await db
        .selectFrom("signals")
        .where("edition_id", "=", editionId)
        .where("signal_kind", "=", signalKind)
        .select((eb) => eb.fn.count<number>("id").as("cnt"))
        .executeTakeFirstOrThrow();
      return Number(result.cnt);
    },

    async getBySourceIdentity(sourceIdentity) {
      return db
        .selectFrom("signals")
        .selectAll()
        .where("source_identity", "=", sourceIdentity)
        .orderBy("created_at", "desc")
        .execute();
    },

    async getFeedbackSummary(opts) {
      const editionId = opts?.editionId;
      const limit = opts?.limit ?? 10;

      let countsQ = db
        .selectFrom("signals")
        .select("signal_kind")
        .select((eb) => eb.fn.count<number>("id").as("cnt"))
        .groupBy("signal_kind");
      if (editionId !== undefined) {
        countsQ = countsQ.where("edition_id", "=", editionId);
      }
      const countsRes = await countsQ.execute();
      const signalCounts: Record<string, number> = {};
      for (const row of countsRes) {
        signalCounts[row.signal_kind] = Number(row.cnt);
      }

      let totalQ = db
        .selectFrom("signals")
        .select((eb) => eb.fn.count<number>("id").as("cnt"));
      if (editionId !== undefined) {
        totalQ = totalQ.where("edition_id", "=", editionId);
      }
      const totalRes = await totalQ.executeTakeFirstOrThrow();
      const totalSignals = Number(totalRes.cnt);

      let sicQ = db
        .selectFrom("signals")
        .where("source_identity", "is not", null)
        .select(
          (eb) =>
            eb.fn
              .count<number>(sql<string>`distinct source_identity`)
              .as("cnt"),
        );
      if (editionId !== undefined) {
        sicQ = sicQ.where("edition_id", "=", editionId);
      }
      const sicRes = await sicQ.executeTakeFirstOrThrow();
      const sourceIdentityCount = Number(sicRes.cnt);

      let svcQ = db
        .selectFrom("signals")
        .where("story_id", "is not", null)
        .where("signal_kind", "in", ["story_up", "story_down"])
        .select(
          (eb) =>
            eb.fn.count<number>(sql<string>`distinct story_id`).as("cnt"),
        );
      if (editionId !== undefined) {
        svcQ = svcQ.where("edition_id", "=", editionId);
      }
      const svcRes = await svcQ.executeTakeFirstOrThrow();
      const storyVoteCount = Number(svcRes.cnt);

      let mutesQ = db
        .selectFrom("signals")
        .select("source_identity")
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .where("signal_kind", "=", "source_muted")
        .where("source_identity", "is not", null)
        .groupBy("source_identity")
        .orderBy("n", "desc")
        .limit(limit);
      if (editionId !== undefined) {
        mutesQ = mutesQ.where("edition_id", "=", editionId);
      }
      const mutesRes = await mutesQ.execute();
      const topMutedSources: MutedSourceAggregate[] = mutesRes.map((r) => ({
        source_identity: r.source_identity!,
        mute_count: Number(r.n),
      }));

      let votedQ = db
        .selectFrom("signals")
        .select("story_id")
        .select((eb) =>
          eb.fn
            .sum<number>(
              sql`case when signal_kind = 'story_up' then 1 else -1 end`,
            )
            .as("net_score"),
        )
        .select(
          (eb) =>
            sql<number>`count(*) filter (where ${eb.ref("signal_kind")} = 'story_up')`.as(
              "up",
            ),
        )
        .select(
          (eb) =>
            sql<number>`count(*) filter (where ${eb.ref("signal_kind")} = 'story_down')`.as(
              "down",
            ),
        )
        .where("story_id", "is not", null)
        .groupBy("story_id")
        .orderBy(
          sql`abs(sum(case when signal_kind = 'story_up' then 1 else -1 end))`,
          "desc",
        )
        .limit(limit);
      if (editionId !== undefined) {
        votedQ = votedQ.where("edition_id", "=", editionId);
      }
      const votedRes = await votedQ.execute();
      const topVotedStories: VotedStoryAggregate[] = votedRes.map((r) => ({
        story_id: r.story_id!,
        net_score: Number(r.net_score),
        up: Number(r.up),
        down: Number(r.down),
      }));

      let starredQ = db
        .selectFrom("signals")
        .select("chunk_id")
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .where("signal_kind", "=", "chunk_starred")
        .where("chunk_id", "is not", null)
        .groupBy("chunk_id")
        .orderBy("n", "desc")
        .limit(limit);
      if (editionId !== undefined) {
        starredQ = starredQ.where("edition_id", "=", editionId);
      }
      const starredRes = await starredQ.execute();
      const topStarredChunks: StarredChunkAggregate[] = starredRes.map((r) => ({
        chunk_id: r.chunk_id!,
        star_count: Number(r.n),
      }));

      return {
        signalCounts,
        totalSignals,
        topMutedSources,
        topVotedStories,
        topStarredChunks,
        sourceIdentityCount,
        storyVoteCount,
      };
    },

    async getSourceIdentityStats(sourceIdentity) {
      const muteRow = await db
        .selectFrom("signals")
        .where("source_identity", "=", sourceIdentity)
        .where("signal_kind", "=", "source_muted")
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .executeTakeFirstOrThrow();
      const mute_count = Number(muteRow.n);

      const starRow = await db
        .selectFrom("signals")
        .where("source_identity", "=", sourceIdentity)
        .where("signal_kind", "=", "chunk_starred")
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .executeTakeFirstOrThrow();
      const chunk_star_count = Number(starRow.n);

      const citedRow = await db
        .selectFrom("signals")
        .where("source_identity", "=", sourceIdentity)
        .where("story_id", "is not", null)
        .select(
          (eb) =>
            eb.fn.count<number>(sql<string>`distinct story_id`).as("n"),
        )
        .executeTakeFirstOrThrow();
      const cited_in_story_count = Number(citedRow.n);

      const totalRow = await db
        .selectFrom("signals")
        .where("source_identity", "=", sourceIdentity)
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .executeTakeFirstOrThrow();
      const total_signals = Number(totalRow.n);

      return {
        source_identity: sourceIdentity,
        mute_count,
        chunk_star_count,
        cited_in_story_count,
        total_signals,
      };
    },
  };
}