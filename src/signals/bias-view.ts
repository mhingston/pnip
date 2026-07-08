import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";

export interface StoryBiasEntry {
  story_id: string;
  up_votes: number;
  down_votes: number;
  net_score: number;
}

export interface SourceBiasEntry {
  source_identity: string;
  muted: boolean;
  mute_count: number;
}

export interface BiasView {
  storyBias: Map<string, StoryBiasEntry>;
  sourceBias: Map<string, SourceBiasEntry>;
  mutedSourceIdentities: Set<string>;
}

export async function getBiasView(
  db: Kysely<Database>,
  editionId: string,
): Promise<BiasView> {
  const storyRows = await db
    .selectFrom("signals")
    .where("edition_id", "=", editionId)
    .where("signal_kind", "in", ["story_up", "story_down"])
    .select([
      "story_id",
      "signal_kind",
      (eb) => eb.fn.count<number>("id").as("cnt"),
    ])
    .groupBy(["story_id", "signal_kind"])
    .execute();

  const storyBias = new Map<string, StoryBiasEntry>();
  for (const row of storyRows) {
    if (!row.story_id) continue;
    const entry = storyBias.get(row.story_id) ?? {
      story_id: row.story_id,
      up_votes: 0,
      down_votes: 0,
      net_score: 0,
    };
    if (row.signal_kind === "story_up") entry.up_votes += Number(row.cnt);
    else if (row.signal_kind === "story_down") entry.down_votes += Number(row.cnt);
    entry.net_score = entry.up_votes - entry.down_votes;
    storyBias.set(row.story_id, entry);
  }

  const sourceRows = await db
    .selectFrom("signals")
    .where("edition_id", "=", editionId)
    .where("signal_kind", "=", "source_muted")
    .select([
      "source_identity",
      (eb) => eb.fn.count<number>("id").as("cnt"),
    ])
    .groupBy("source_identity")
    .execute();

  const sourceBias = new Map<string, SourceBiasEntry>();
  for (const row of sourceRows) {
    if (!row.source_identity) continue;
    sourceBias.set(row.source_identity, {
      source_identity: row.source_identity,
      muted: true,
      mute_count: Number(row.cnt),
    });
  }

  const mutedSourceIdentities = new Set(sourceBias.keys());

  return { storyBias, sourceBias, mutedSourceIdentities };
}
