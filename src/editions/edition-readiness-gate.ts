import { Kysely, sql } from "kysely";
import type { Database, Edition } from "../database/kysely.js";
import { type EditionRepository } from "./edition-repository.js";
import { type EditionAssemblyService } from "./edition-assembly-service.js";

export interface EditionReadinessGateDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  assembly: EditionAssemblyService;
}

export interface EditionReadinessGate {
  transitionToReadyIfReady(editionId: string): Promise<{
    transitioned: boolean;
    reason: string;
    edition: Edition;
  }>;
}

export function createEditionReadinessGate(
  deps: EditionReadinessGateDeps,
): EditionReadinessGate {
  return {
    async transitionToReadyIfReady(editionId) {
      return deps.db.transaction().execute(async (trx) => {
        const current = await deps.editionRepo.getById(editionId);
        if (!current) {
          throw new Error(`edition not found: ${editionId}`);
        }
        if (current.status !== "building") {
          return {
            transitioned: false,
            reason: `edition status is '${current.status}', not 'building'`,
            edition: current,
          };
        }
        const readiness = await deps.assembly.getReadiness(editionId);
        if (!readiness.isReady) {
          return { transitioned: false, reason: readiness.reason, edition: current };
        }
        const updated = await trx
          .updateTable("editions")
          .set({ status: "ready", updated_at: sql<Date>`now()` })
          .where("id", "=", editionId)
          .where("status", "=", "building")
          .returningAll()
          .executeTakeFirst();
        if (!updated) {
          const latest = await deps.editionRepo.getById(editionId);
          return {
            transitioned: false,
            reason: "concurrent state change prevented transition",
            edition: latest!,
          };
        }
        return {
          transitioned: true,
          reason: "edition is fully ready",
          edition: updated as Edition,
        };
      });
    },
  };
}
