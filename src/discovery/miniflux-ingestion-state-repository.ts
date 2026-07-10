import type { Kysely, Transaction } from "kysely";
import type { Database } from "../database/kysely.js";

const STATE_KEY = "default";

export interface MinifluxIngestionState {
  source_key: string;
  last_entry_id: string;
  last_ingested_at: Date;
}

export interface MinifluxIngestionStateRepository {
  get(): Promise<MinifluxIngestionState | undefined>;
  set(input: {
    lastEntryId: number;
    lastIngestedAt?: Date;
  }, db?: Kysely<Database> | Transaction<Database>): Promise<void>;
}

export function createMinifluxIngestionStateRepository(
  db: Kysely<Database>,
): MinifluxIngestionStateRepository {
  return {
    async get() {
      return db
        .selectFrom("miniflux_ingestion_state")
        .selectAll()
        .where("source_key", "=", STATE_KEY)
        .executeTakeFirst() as Promise<MinifluxIngestionState | undefined>;
    },

    async set(input, connection = db) {
      await connection
        .insertInto("miniflux_ingestion_state")
        .values({
          source_key: STATE_KEY,
          last_entry_id: String(input.lastEntryId),
          last_ingested_at: input.lastIngestedAt ?? new Date(),
        })
        .onConflict((oc) =>
          oc.column("source_key").doUpdateSet({
            last_entry_id: String(input.lastEntryId),
            last_ingested_at: input.lastIngestedAt ?? new Date(),
          }),
        )
        .execute();
    },
  };
}
