import { Kysely, sql } from "kysely";
import type { Database, DiscoveryEvent } from "../database/kysely.js";

export type { DiscoveryEvent } from "../database/kysely.js";

export interface DiscoveryEventInput {
  editionId: string;
  minifluxEntryId: number;
  feedId: number;
  title?: string;
  url: string;
  hash?: string;
  publishedAt?: Date | string;
  metadata?: unknown;
}

export interface DiscoveryRepository {
  getOrCreate(
    input: DiscoveryEventInput,
  ): Promise<{ event: DiscoveryEvent; created: boolean }>;
  getByMinifluxEntryId(
    minifluxEntryId: number,
  ): Promise<DiscoveryEvent | undefined>;
  getById(id: string): Promise<DiscoveryEvent | undefined>;
  listByEdition(editionId: string): Promise<DiscoveryEvent[]>;
  countByEdition(editionId: string): Promise<number>;
}

function toMetadata(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function toPublishedAt(value: Date | string | undefined): Date | null {
  if (value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function toRow(input: DiscoveryEventInput) {
  return {
    edition_id: input.editionId,
    miniflux_entry_id: String(input.minifluxEntryId),
    feed_id: String(input.feedId),
    title: input.title ?? null,
    url: input.url,
    hash: input.hash ?? null,
    published_at: toPublishedAt(input.publishedAt),
    metadata: toMetadata(input.metadata),
  };
}

export function createDiscoveryRepository(
  db: Kysely<Database>,
): DiscoveryRepository {
  return {
    async getOrCreate(
      input: DiscoveryEventInput,
    ): Promise<{ event: DiscoveryEvent; created: boolean }> {
      const inserted = await db
        .insertInto("discovery_events")
        .values(toRow(input))
        .onConflict((oc) => oc.column("miniflux_entry_id").doNothing())
        .returningAll()
        .execute();
      if (inserted.length === 1) {
        return { event: inserted[0] as DiscoveryEvent, created: true };
      }
      const existing = await db
        .selectFrom("discovery_events")
        .selectAll()
        .where("miniflux_entry_id", "=", String(input.minifluxEntryId))
        .executeTakeFirst();
      return { event: existing as DiscoveryEvent, created: false };
    },

    async getByMinifluxEntryId(
      minifluxEntryId: number,
    ): Promise<DiscoveryEvent | undefined> {
      const row = await db
        .selectFrom("discovery_events")
        .selectAll()
        .where("miniflux_entry_id", "=", String(minifluxEntryId))
        .executeTakeFirst();
      return row as DiscoveryEvent | undefined;
    },

    async getById(id: string): Promise<DiscoveryEvent | undefined> {
      const row = await db
        .selectFrom("discovery_events")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row as DiscoveryEvent | undefined;
    },

    async listByEdition(editionId: string): Promise<DiscoveryEvent[]> {
      const rows = await db
        .selectFrom("discovery_events")
        .selectAll()
        .where("edition_id", "=", editionId)
        .orderBy("discovered_at", "asc")
        .execute();
      return rows as DiscoveryEvent[];
    },

    async countByEdition(editionId: string): Promise<number> {
      const result = await sql<{ count: string }>`SELECT COUNT(*)::text AS count
        FROM discovery_events
        WHERE edition_id = ${editionId}`.execute(db);
      return Number(result.rows[0].count);
    },
  };
}
