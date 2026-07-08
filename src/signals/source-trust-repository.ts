import { Kysely, sql } from "kysely";
import type { Database } from "../database/kysely.js";

export interface SourceTrustRow {
  source_identity: string;
  tier: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SourceTrustRepository {
  set(sourceIdentity: string, tier: number, notes?: string | null): Promise<SourceTrustRow>;
  get(sourceIdentity: string): Promise<SourceTrustRow | undefined>;
  getAll(): Promise<SourceTrustRow[]>;
  delete(sourceIdentity: string): Promise<void>;
}

export function createSourceTrustRepository(
  db: Kysely<Database>,
): SourceTrustRepository {
  return {
    async set(sourceIdentity, tier, notes) {
      return db
        .insertInto("source_trust")
        .values({
          source_identity: sourceIdentity,
          tier,
          notes: notes ?? null,
        })
        .onConflict((b) =>
          b.column("source_identity").doUpdateSet({
            tier,
            notes: notes ?? null,
            updated_at: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async get(sourceIdentity) {
      return db
        .selectFrom("source_trust")
        .selectAll()
        .where("source_identity", "=", sourceIdentity)
        .executeTakeFirst();
    },

    async getAll() {
      return db
        .selectFrom("source_trust")
        .selectAll()
        .orderBy("source_identity", "asc")
        .execute();
    },

    async delete(sourceIdentity) {
      await db
        .deleteFrom("source_trust")
        .where("source_identity", "=", sourceIdentity)
        .execute();
    },
  };
}
