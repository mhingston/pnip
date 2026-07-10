import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import type { PartitionConfig } from "../config/index.js";
import { PARTITION_MASTER } from "../discovery/partition-resolver.js";

export interface ActivePartition {
  partitionKey: string;
  documentCount: number;
  withPodcast: boolean;
}

const DEFAULT_MIN_ARTICLES = 5;

export async function getActivePartitions(input: {
  db: Kysely<Database>;
  editionId: string;
  config: PartitionConfig;
}): Promise<ActivePartition[]> {
  const { db, editionId, config } = input;

  const rows = await db
    .selectFrom("documents")
    .select((eb) => [
      "partition_key",
      eb.fn.count<number>("id").as("n"),
    ])
    .where("edition_id", "=", editionId)
    .groupBy("partition_key")
    .execute();

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.partition_key, Number(r.n));
  }

  // Master is the complete edition. Stored partition keys describe optional
  // output slices; they do not remove a document from the master view.
  const masterCount = Array.from(counts.values()).reduce(
    (total, count) => total + count,
    0,
  );

  const result: ActivePartition[] = [
    {
      partitionKey: PARTITION_MASTER,
      documentCount: masterCount,
      withPodcast: false,
    },
  ];

  for (const [partitionKey, entry] of Object.entries(config)) {
    if (entry.enabled === false) continue;
    const minArticles = entry.min_articles ?? DEFAULT_MIN_ARTICLES;
    const count = counts.get(partitionKey) ?? 0;
    if (count < minArticles) continue;
    result.push({
      partitionKey,
      documentCount: count,
      withPodcast: entry.with_podcast ?? false,
    });
  }

  return result;
}
