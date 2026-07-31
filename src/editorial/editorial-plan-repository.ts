import { Kysely, type Transaction } from "kysely";
import type { Database, EditorialPlanRow } from "../database/kysely.js";
import type { EditorialPlan } from "./editorial-plan-schema.js";

export interface SaveEditorialPlanInput {
  editionId: string;
  inputHash: string;
  plan: EditorialPlan;
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  usedFallback: boolean;
}

export interface EditorialPlanRepository {
  getByEdition(editionId: string): Promise<EditorialPlanRow | undefined>;
  save(input: SaveEditorialPlanInput, db?: Kysely<Database> | Transaction<Database>): Promise<EditorialPlanRow>;
  deleteByEdition(editionId: string): Promise<void>;
}

export function createEditorialPlanRepository(db: Kysely<Database>): EditorialPlanRepository {
  return {
    getByEdition: (editionId) => db.selectFrom("editorial_plans").selectAll().where("edition_id", "=", editionId).executeTakeFirst(),
    async save(input, connection) {
      const conn = connection ?? db;
      return conn.insertInto("editorial_plans").values({
        edition_id: input.editionId,
        input_hash: input.inputHash,
        plan: JSON.stringify(input.plan),
        prompt_id: input.promptId,
        prompt_version: input.promptVersion,
        model: input.model,
        provider: input.provider,
        used_fallback: input.usedFallback,
      }).onConflict((oc) => oc.column("edition_id").doUpdateSet({
        input_hash: input.inputHash,
        plan: JSON.stringify(input.plan),
        prompt_id: input.promptId,
        prompt_version: input.promptVersion,
        model: input.model,
        provider: input.provider,
        used_fallback: input.usedFallback,
        updated_at: new Date(),
      })).returningAll().executeTakeFirstOrThrow();
    },
    async deleteByEdition(editionId) { await db.deleteFrom("editorial_plans").where("edition_id", "=", editionId).execute(); },
  };
}
