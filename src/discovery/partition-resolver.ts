import type { PartitionConfig } from "../config/index.js";
import type { MinifluxCategory, MinifluxEntry } from "./miniflux-client.js";

export const PARTITION_MASTER = "master";
export type PartitionKey = string;

export function categoryToPartitionKey(input: {
  category: MinifluxCategory | null | undefined;
  config?: PartitionConfig;
}): PartitionKey {
  if (!input.category) return PARTITION_MASTER;
  const config = input.config ?? {};
  const titleLower = input.category.title.toLowerCase();
  for (const [partitionKey, entry] of Object.entries(config)) {
    if (!entry) continue;
    if (entry.enabled === false) continue;
    if (
      typeof entry.category === "string" &&
      entry.category.toLowerCase() === titleLower
    ) {
      return partitionKey;
    }
    if (
      typeof entry.category_id === "number" &&
      entry.category_id === input.category.id
    ) {
      return partitionKey;
    }
  }
  return PARTITION_MASTER;
}

export function resolvePartitionKey(input: {
  entry: Pick<MinifluxEntry, "category">;
  config?: PartitionConfig;
}): PartitionKey {
  return categoryToPartitionKey({
    category: input.entry.category,
    config: input.config,
  });
}