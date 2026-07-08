import { Kysely } from "kysely";
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
  };
}
