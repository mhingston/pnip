import type { PartitionConfig } from "../config/index.js";
import type { ActivePartition } from "../publication/active-partitions.js";

export interface ActivePartitionsCommandDeps {
  editionDate: string;
  partitionConfig: PartitionConfig;
  resolveEditionId: (date: string) => Promise<string | undefined>;
  resolveActivePartitions: (editionId: string, config: PartitionConfig) => Promise<ActivePartition[]>;
  log?: (line: string) => void;
}

export async function runActivePartitionsCommand(
  deps: ActivePartitionsCommandDeps,
): Promise<{ exitCode: number }> {
  const log = deps.log ?? console.log;
  const editionId = await deps.resolveEditionId(deps.editionDate);
  if (!editionId) {
    log(`active-partitions: no edition found for date ${deps.editionDate}`);
    return { exitCode: 1 };
  }
  const partitions = await deps.resolveActivePartitions(editionId, deps.partitionConfig);
  for (const partition of partitions) {
    const withPodcast = partition.partitionKey === "master" || partition.withPodcast;
    log(`${partition.partitionKey}${withPodcast ? ":with_podcast" : ""}`);
  }
  return { exitCode: 0 };
}

export function parseActivePartitionsDate(args: string[]): string | undefined {
  return args.length === 2 && args[0] === "--date" && /^\d{4}-\d{2}-\d{2}$/.test(args[1]!)
    ? args[1]
    : undefined;
}
